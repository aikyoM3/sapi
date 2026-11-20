"""Assertions for offline fixtures only, not an invoice scoring program."""
import csv
import json
import sys
from pathlib import Path
from pypdf import PdfReader

with open(sys.argv[1], encoding='utf-8-sig', newline='') as stream:
    rows = list(csv.DictReader(stream))
assert len(rows) == 61
assert rows[0]['name'] == 'Bánh "kẹo", xoài\n180g'
assert rows[0]['total_price'] == '999'
assert all(not row[k] for row in rows for k in row if k.endswith('_review') or k.endswith('_actual') or k == 'notes')
pdf = PdfReader(sys.argv[2])
text = '\n'.join(page.extract_text() for page in pdf.pages)
manifest = json.loads((Path(sys.argv[2]).parent / 'manifest.json').read_text(encoding='utf-8'))
assert len(pdf.pages) >= 26
for image in manifest['images']:
    assert image['image_id'] in text
for page in pdf.pages:
    objects = page.get('/Resources', {}).get('/XObject', {})
    has_photo = any(obj.get_object().get('/Subtype') == '/Image' for obj in objects.values())
    if has_photo:
        assert any(image['image_id'] in page.extract_text() for image in manifest['images']), 'Photo orphaned from its image ID'
assert 'Địa chỉ' in text and '999' in text and 'OFFLINE_FIXTURE' in text
print(f'CSV round trip, blank review columns and PDF text OK ({len(pdf.pages)} pages).')
