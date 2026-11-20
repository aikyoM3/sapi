"""Review saved IN-12/VT-26 evidence only. No AI, DB, network, or grading."""
import argparse
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from xml.sax.saxutils import escape

from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle

from render_report import render, fonts


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main(run_dir):
    stamp = datetime.now(ZoneInfo('Asia/Ho_Chi_Minh')).strftime('%Y%m%d-%H%M%S')
    evidence = run_dir / ('error-evidence-' + stamp)
    evidence.mkdir(exist_ok=False)
    temp = run_dir / 'tmp' / 'pdfs' / stamp
    temp.mkdir(parents=True, exist_ok=False)
    sources = []
    for image_id in ('IN-12', 'VT-26'):
        for source in sorted((run_dir / 'history').glob(image_id + '-*.json')):
            sources.append((image_id, 'history', source))
        sources.append((image_id, 'current', run_dir / 'results' / (image_id + '.json')))
    for label in ('gemini-in12-temperature1', 'gemini-in12-temp1-row-check'):
        source = run_dir.parent / label / 'results' / 'IN-12.json'
        if source.is_file():
            sources.append(('IN-12', label, source))

    entries = []
    for image_id, label, source in sources:
        original = source.read_bytes()
        # Do not silently alter evidence. Refuse accidental credentials instead.
        text = original.decode('utf-8')
        if re.search(r'AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z_-]{35,}', text):
            raise RuntimeError('Có chuỗi giống API key trong log; không xuất: ' + str(source))
        r = json.loads(text)
        tag = image_id + '-' + (source.stem if label == 'history' else label)
        raw_copy = evidence / (tag + '.record.json')
        raw_copy.write_bytes(original)
        files = [{'path': raw_copy.name, 'kind': 'record', 'sha256': sha(original), 'bytes': len(original)}]

        def save_response(name, value, kind):
            data = value.encode('utf-8')
            (evidence / name).write_bytes(data)
            assert (evidence / name).read_bytes() == data
            files.append({'path': name, 'kind': kind, 'sha256': sha(data), 'bytes': len(data), 'characters': len(value)})

        if r.get('raw_text') is not None:
            save_response(tag + '.model-text.txt', r['raw_text'], 'model_text')
        http_summary = []
        for number, response in enumerate(r.get('transport_responses', []), 1):
            if response.get('raw_text') is not None:
                save_response(f'{tag}.http-{number}.txt', response['raw_text'], 'http_body')
            body = response.get('body') or {}
            candidates = body.get('candidates') or []
            http_summary.append({'http_status': response.get('http_status'),
                                 'finish_reasons': [c.get('finishReason') for c in candidates],
                                 'function_names': [part['functionCall'].get('name') for c in candidates for part in c.get('content', {}).get('parts', []) if part.get('functionCall')]})
        if image_id == 'VT-26' and label == 'current':
            note = 'HTTP 200 nhưng không đạt schema. Có trường bắt buộc bị thiếu và chuỗi "null" thay vì null. Phản hồi nguyên văn có phần thập phân rất dài; giữ nguyên trong TXT, không làm tròn hoặc tính bù.'
        elif label == 'current':
            note = 'Lần thử mới nhất đã được service chấp nhận về schema. Chưa đánh giá độ chính xác OCR. Không dùng kết quả này để xóa lịch sử các lần lỗi.'
        elif label.startswith('gemini-in12'):
            note = 'Lượt chẩn đoán riêng với temperature 1, khác cấu hình bộ 26 ảnh. HTTP 200 nhưng trả functionCall write_file; dữ liệu nằm trong args.Content, không phải text theo hợp đồng. Không thực thi functionCall và không tính là kết quả hợp lệ của bộ 26 ảnh.'
        elif r.get('error', {}).get('status') == 504:
            note = 'Timeout: không có HTTP response body được log. Không có phản hồi để trích lại; không tự tạo dữ liệu thay thế.'
        else:
            note = 'HTTP 200 nhưng finishReason MALFORMED_FUNCTION_CALL; service không nhận được JSON văn bản hợp lệ. Xem nguyên văn body HTTP, không coi các đoạn thought là kết quả hóa đơn.'
        entries.append({'image_id': image_id, 'label': label, 'source': str(source.relative_to(run_dir.parent)),
                        'source_sha256': sha(original), 'status': r['status'], 'started_at': r.get('started_at'),
                        'elapsed_ms': r.get('elapsed_ms'), 'model_used': r.get('model_used'), 'model_version': r.get('model_version'),
                        'attempts': r.get('attempts', []), 'error': r.get('error'), 'http': http_summary, 'note': note, 'files': files})

    index = {'generated_timezone': 'Asia/Ho_Chi_Minh', 'no_api_calls': True,
             'description': 'Exact saved strings as UTF-8. Record JSON copied byte-for-byte. No OCR corrections or scoring.', 'entries': entries}
    (evidence / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding='utf-8')
    readme = ['BẰNG CHỨNG PHẢN HỒI GEMINI - IN-12 VÀ VT-26', '',
              'Không gọi lại API. Không sửa kết quả/ảnh gốc, không tự chấm độ chính xác.',
              '*.http-N.txt: nguyên văn HTTP body đã được lưu trong transport_responses[N-1].raw_text.',
              '*.model-text.txt: nguyên văn phần text model mà SDK/service nhận được.',
              '*.record.json: bản sao byte-for-byte của JSON kết quả/lỗi gốc.',
              'Không có http-*.txt nghĩa là log không lưu HTTP body; không suy diễn nội dung phản hồi.',
              'Bí mật (nếu có) đã được cơ chế log gốc che trước khi ghi. Không phải log mạng đầy đủ khi nguồn không có.',
              'index.json chứa đường dẫn nguồn, trạng thái, cấu hình từng lượt và SHA-256 để đối chiếu.', '']

    fonts()
    body = ParagraphStyle('EvidenceBody', fontName='Sapi', fontSize=10, leading=14, spaceAfter=7, wordWrap='CJK')
    title = ParagraphStyle('EvidenceTitle', parent=body, fontName='SapiBold', fontSize=17, leading=22, spaceAfter=12)
    heading = ParagraphStyle('EvidenceHeading', parent=body, fontName='SapiBold', fontSize=12, leading=17)
    small = ParagraphStyle('EvidenceSmall', parent=body, fontSize=9, leading=12)

    def p(text, style=body):
        return Paragraph(escape(str(text)).replace('\n', '<br/>'), style)

    current = {json.loads(file.read_text(encoding='utf-8'))['status']: 0 for file in (run_dir / 'results').glob('*.json')}
    for file in (run_dir / 'results').glob('*.json'):
        current[json.loads(file.read_text(encoding='utf-8'))['status']] += 1
    story = [p('Phụ lục - Hai chứng từ từng gặp lỗi', title),
             p('Phạm vi: IN-12 và VT-26. Giữ cả lịch sử lỗi, các lượt chẩn đoán riêng và kết quả mới nhất. Không gộp các cấu hình khác nhau thành một lượt thực nghiệm.'),
             p(f'Bộ 26 ảnh hiện tại: {current.get("success", 0)} kết quả đạt cấu trúc JSON, {current.get("error", 0)} lỗi. Đây không phải tỷ lệ chính xác OCR.'),
             p('IN-12: từng lỗi định dạng, timeout; bản hiện tại đã đạt schema. VT-26: từng timeout; hiện tại vẫn lỗi schema.'),
             p('HTTP 200 chỉ là phản hồi giao thức thành công, không đảm bảo nội dung JSON đúng schema hoặc OCR đúng.'),
             p('Phản hồi dài được đính kèm nguyên văn để tránh chữ nhỏ, tràn trang hoặc mất chữ số. PDF chỉ trích đoạn có nhãn rõ ràng; không thay thế dữ liệu gốc.'),
             p('Thư mục đính kèm: ' + evidence.name, heading)]
    for image_id in ('IN-12', 'VT-26'):
        story.extend([Spacer(1, 8), p('Lịch sử ' + image_id, heading)])
        for e in (e for e in entries if e['image_id'] == image_id):
            story.append(p(f'{e["label"]}: {e["status"]} | {e["elapsed_ms"]} ms | {e["model_used"] or "chưa nhận model trả về"}', small))
    for e in entries:
        story += [PageBreak(), p('Bằng chứng ' + e['image_id'] + ' - ' + e['label'], title),
                  p('Nguồn: ' + e['source'], small),
                  p(f'Trạng thái: {e["status"]} | Thời gian: {e["elapsed_ms"]} ms'),
                  p(f'Model phản hồi: {e["model_used"]} | Phiên bản: {e["model_version"]}'), p(e['note'])]
        if e['attempts']:
            story.append(p('Model đã thử: ' + ', '.join(str(a.get('model')) for a in e['attempts'])))
        if e['error']:
            story += [p('Thông báo lỗi SAPI (không phải nguyên văn model)', heading), p(json.dumps(e['error'], ensure_ascii=False))]
        if e['http']:
            story += [p('Trạng thái HTTP / finishReason', heading), p(json.dumps(e['http'], ensure_ascii=False))]
        else:
            story.append(p('Không có body HTTP trong log nguồn. Không có nội dung phản hồi để bổ sung.'))
        candidates = [f for f in e['files'] if f['kind'] in ('http_body', 'model_text')]
        for f in candidates:
            raw = (evidence / f['path']).read_text(encoding='utf-8')
            if len(raw) <= 1600:
                story.extend([p('Nguyên văn phản hồi: ' + f['path'], heading), p(raw, small)])
            else:
                story.extend([p('Trích đoạn phản hồi: ' + f['path'], heading), p(raw[:800], small),
                              p(f'[Chỉ hiển thị 800/{len(raw)} ký tự. File đính kèm giữ nguyên toàn bộ {f["bytes"]} byte UTF-8.]', small)])
        story += [Spacer(1, 5), p('Các file đính kèm đầy đủ', heading)]
        for f in e['files']:
            story.append(p(f'{f["path"]} ({f["bytes"]} byte)', small))
        readme += [e['image_id'] + ' - ' + e['label'], 'Nguồn: ' + e['source'], e['note'],
                   *[f['path'] for f in e['files']], '']
    (evidence / 'README.txt').write_text('\n'.join(readme), encoding='utf-8-sig')
    appendix = temp / 'appendix.pdf'
    def footer(canvas, doc):
        canvas.setFont('Sapi', 8)
        canvas.drawString(32, 15, 'SAPI - Lịch sử lỗi; trích dẫn log đã lưu, không gọi lại Gemini')
        canvas.drawRightString(A4[0] - 32, 15, 'Phụ lục ' + str(doc.page))
    SimpleDocTemplate(str(appendix), pagesize=A4, leftMargin=32, rightMargin=32, topMargin=32, bottomMargin=32).build(story, onFirstPage=footer, onLaterPages=footer)
    base = render(run_dir, output_path=temp / 'base.pdf', raw_text_limit=800, response_directory=evidence.name)
    output = run_dir / ('review-with-error-history-' + stamp + '.pdf')
    writer = PdfWriter()
    writer.append(str(base))
    writer.append(str(appendix))
    # Embed the evidence too: downloading the PDF alone retains the exact logs.
    for file in sorted(evidence.iterdir()):
        writer.add_attachment(file.name, file.read_bytes())
    writer.add_metadata({'/Title': 'SAPI - Bộ 26 ảnh và lịch sử lỗi IN-12, VT-26', '/Author': 'SAPI'})
    with output.open('xb') as stream:
        writer.write(stream)
    reader = PdfReader(output)
    assert len(reader.pages) == len(PdfReader(base).pages) + len(PdfReader(appendix).pages)
    assert len(reader.attachments) == len(list(evidence.iterdir()))
    for file in evidence.iterdir():
        assert reader.attachments[file.name][0] == file.read_bytes()
    # Confirm all original JSON files are untouched after report generation.
    for e in entries:
        assert sha((run_dir.parent / e['source']).read_bytes()) == e['source_sha256']
    print(json.dumps({'pdf': str(output), 'evidence': str(evidence), 'pages': len(reader.pages),
                      'base_pages': len(PdfReader(base).pages), 'entries': len(entries),
                      'embedded_files': len(reader.attachments), 'statuses': current,
                      'original_records_unchanged': True}, ensure_ascii=False))


if __name__ == '__main__':
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-dir', type=Path, required=True)
    main(parser.parse_args().run_dir.resolve())
