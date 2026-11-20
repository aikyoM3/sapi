"""Read-only output-integrity checks. Does not grade Gemini or edit any data."""
import argparse
import csv
import hashlib
import io
import json
import re
import sys
from collections import Counter
from decimal import Decimal
from pathlib import Path

from pypdf import PdfReader


def verify(run_dir, csv_file, pdf_file):
    backend = Path(__file__).resolve().parents[2]
    manifest = json.loads((run_dir / 'manifest.json').read_text(encoding='utf-8'))
    assert not manifest['fixture'], 'Fixture outputs are not research data.'
    assert len(manifest['images']) == 26
    assert Counter(i['group'] for i in manifest['images']) == {'Giấy in': 17, 'Điền khung': 2, 'Viết tay': 7}
    records = []
    for image in manifest['images']:
        assert hashlib.sha256((backend / image['source_path']).read_bytes()).hexdigest() == image['image_sha256']
        record = json.loads((run_dir / 'results' / (image['image_id'] + '.json')).read_text(encoding='utf-8'))
        assert record['image_id'] == image['image_id']
        assert record['protocol_fingerprint'] == manifest['fingerprint']
        assert record['status'] in ('success', 'error'), 'Image is unfinished.'
        assert not record['fixture']
        if record['status'] == 'success':
            assert json.loads(record['raw_text']) == record['gemini']
        records.append(record)

    data = csv_file.read_bytes()
    assert data.startswith(b'\xef\xbb\xbf'), 'CSV needs UTF-8 BOM.'
    reader = csv.DictReader(io.StringIO(data.decode('utf-8-sig'), newline=''))
    rows = list(reader)
    review_columns = [c for c in reader.fieldnames if c.endswith(('_review', '_actual')) or c == 'notes']
    assert review_columns
    assert all(row[c] == '' for row in rows for c in review_columns), 'Manual review columns must stay blank.'
    expected = []
    for record in records:
        if record['status'] != 'success':
            continue
        g = record['gemini']
        doc = dict(zip(['supplier_name', 'supplier_phone', 'supplier_address', 'supplier_tax_code', 'invoice_number', 'invoice_date', 'total_amount'],
                       [g['supplier']['name'], g['supplier']['phone'], g['supplier']['address'], g['supplier']['tax_code'], g['invoice']['number'], g['invoice']['date'], g['total_amount']]))
        for index, item in enumerate(g['items'], 1):
            expected.append({'image_id': record['image_id'], 'item_no': str(index), 'group': record['group'], 'kind': record['kind'], 'source_path': record['source_path'], **doc, **item})
    assert len(rows) == len(expected), 'CSV must have one row per extracted item.'
    for row, original in zip(rows, expected):
        for field, value in original.items():
            if value is None:
                assert row[field] == '', (row['image_id'], field)
            elif isinstance(value, (int, float)):
                assert Decimal(row[field]) == Decimal(str(value)), (row['image_id'], field)
            else:
                assert row[field] == str(value), (row['image_id'], field)

    pdf = PdfReader(pdf_file)
    page_text = [page.extract_text() or '' for page in pdf.pages]
    starts = []
    for image in manifest['images']:
        pages = [index for index, text in enumerate(page_text) if re.search(r'(?m)^' + re.escape(image['image_id']) + r' \|', text) and 'Nguồn:' in text]
        assert len(pages) == 1, f"Missing/duplicated document start: {image['image_id']}"
        resources = pdf.pages[pages[0]].get('/Resources', {}).get_object()
        objects = resources.get('/XObject', {})
        if hasattr(objects, 'get_object'):
            objects = objects.get_object()
        assert any(obj.get_object().get('/Subtype') == '/Image' for obj in objects.values()), f"Missing source photo: {image['image_id']}"
        starts.append(pages[0])
    assert starts == sorted(starts)
    assert not any('DỮ LIỆU KIỂM THỬ GIẢ LẬP' in text for text in page_text)
    assert not any(re.search(r'AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z_-]{35,}', text) for text in page_text)
    return {
        'images': len(records), 'statuses': dict(Counter(r['status'] for r in records)),
        'csv_item_rows': len(rows), 'review_columns_blank': True,
        'csv_matches_raw_json': True, 'source_hashes_unchanged': True,
        'pdf_pages': len(pdf.pages), 'document_start_pages': [p + 1 for p in starts],
        'models_used': dict(Counter(r['model_used'] for r in records if r['status'] == 'success')),
        'model_versions_reported': dict(Counter(r['model_version'] for r in records if r['status'] == 'success')),
        'empty_item_results': [r['image_id'] for r in records if r['status'] == 'success' and not r['gemini']['items']],
        'errors': [{'image_id': r['image_id'], 'error': r.get('error'), 'transport_responses': len(r.get('transport_responses', []))} for r in records if r['status'] == 'error'],
    }


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--csv', type=Path, required=True)
    parser.add_argument('--pdf', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.run_dir.resolve(), args.csv.resolve(), args.pdf.resolve()), ensure_ascii=False, indent=2))
