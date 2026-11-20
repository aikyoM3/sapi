"""Render saved experiment JSON only. No AI, database or network access."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
from xml.sax.saxutils import escape

from PIL import Image as PILImage, ImageOps
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import BaseDocTemplate, PageTemplate, Frame, Paragraph, Table, TableStyle, Image, PageBreak, NextPageTemplate, Spacer

BACKEND = Path(__file__).resolve().parents[2]
MARGIN = 32

def fonts():
    candidates = [Path(os.environ.get('SAPI_PDF_FONT', 'C:/Windows/Fonts/arial.ttf')), Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]
    regular = next((p for p in candidates if p.is_file()), None)
    if not regular:
        raise RuntimeError('Không tìm thấy font Unicode. Đặt SAPI_PDF_FONT tới file .ttf hỗ trợ tiếng Việt.')
    bold = regular.with_name('arialbd.ttf' if regular.name.lower() == 'arial.ttf' else 'DejaVuSans-Bold.ttf')
    pdfmetrics.registerFont(TTFont('Sapi', str(regular)))
    pdfmetrics.registerFont(TTFont('SapiBold', str(bold if bold.exists() else regular)))

def value(v):
    if v is None:
        return 'null'
    return json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list, bool)) else str(v)

def render(run_dir, output_path=None, raw_text_limit=None, response_directory=None):
    fonts()
    manifest = json.loads((run_dir / 'manifest.json').read_text(encoding='utf-8'))
    body = ParagraphStyle('Body', fontName='Sapi', fontSize=10, leading=14, spaceAfter=5, wordWrap='CJK')
    heading = ParagraphStyle('Heading', parent=body, fontName='SapiBold', fontSize=16, leading=20, spaceAfter=8)
    small = ParagraphStyle('Small', parent=body, fontSize=9, leading=12)
    numeric = ParagraphStyle('Numeric', parent=body, alignment=2)
    def p(text, style=body):
        return Paragraph(escape(str(text)).replace('\n', '<br/>'), style)

    output = output_path or run_dir / 'review.pdf'
    # Version the PDF too; do not overwrite a reviewer's existing document.
    if output.exists():
        from datetime import datetime
        output = run_dir / ('review-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.pdf')
    doc = BaseDocTemplate(str(output), leftMargin=MARGIN, rightMargin=MARGIN, topMargin=MARGIN, bottomMargin=MARGIN, title='SAPI kiểm tra trích xuất Gemini', author='SAPI')
    def footer(canvas, _doc):
        canvas.setFont('Sapi', 8)
        canvas.drawString(MARGIN, 15, 'DỮ LIỆU KIỂM THỬ GIẢ LẬP - KHÔNG PHẢI KẾT QUẢ GEMINI' if manifest.get('fixture') else 'SAPI - Kết quả Gemini gốc, chưa đối chiếu danh mục hoặc hiệu chỉnh')
        canvas.drawRightString(canvas._pagesize[0]-MARGIN, 15, str(_doc.page))
    for name, size in [('portrait', A4), ('landscape', landscape(A4))]:
        doc.addPageTemplates(PageTemplate(id=name, pagesize=size, frames=[Frame(MARGIN, MARGIN, size[0]-2*MARGIN, size[1]-2*MARGIN, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)], onPage=footer))
    story = []
    for index, image in enumerate(manifest['images']):
        source = (BACKEND / image['source_path']).resolve()
        if not source.is_relative_to((BACKEND / 'test_images').resolve()):
            raise RuntimeError('Đường dẫn ảnh không thuộc test_images.')
        if hashlib.sha256(source.read_bytes()).hexdigest() != image['image_sha256']:
            raise RuntimeError('Ảnh đã thay đổi: ' + image['image_id'])
        result_file = run_dir / 'results' / (image['image_id'] + '.json')
        r = json.loads(result_file.read_text(encoding='utf-8')) if result_file.exists() else None
        if r and r.get('protocol_fingerprint') != manifest['fingerprint']:
            raise RuntimeError('Kết quả không khớp manifest: ' + image['image_id'])
        title = f"{image['image_id']} | {image['group']}" + (' | Đặc biệt' if image['kind'] == 'Đặc biệt' else '')
        meta = f"Nguồn: {image['source_path']}\nTrạng thái: {r['status'] if r else 'chưa chạy'}"
        settings = manifest.get('settings', {})
        if settings.get('provider'):
            meta += f"\nKênh API: {settings['provider']} | {settings.get('baseUrl', '')}"
        if r:
            meta += f"\nModel nhận phản hồi: {r.get('model_used')} | Phiên bản: {r.get('model_version')}\nThời gian toàn bộ: {r.get('elapsed_ms')} ms"
            if not r.get('model_used') and r.get('attempts'):
                meta += '\nModel đã thử: ' + ', '.join(a['model'] for a in r['attempts'])
        info = [p(title, heading), p(meta, small)]
        data = []
        if not r or r['status'] != 'success':
            message = r.get('error', {}).get('message') if r and r.get('error') else 'Chưa có kết quả hoàn tất. Không tạo dữ liệu thay thế.'
            data += [p('Lỗi hoặc chưa hoàn tất', heading), p(message)]
            if r and r.get('raw_text'):
                raw = r['raw_text']
                data.append(p('Phản hồi chưa qua kiểm tra schema'))
                if raw_text_limit and len(raw) > raw_text_limit:
                    # Display-only excerpt. The exact saved text is exported by
                    # the evidence script; never change the experiment result.
                    data += [p(raw[:raw_text_limit]), p(f'[Trích {raw_text_limit}/{len(raw)} ký tự; không phải toàn bộ phản hồi.]', small),
                             p(f'Nguyên văn: {response_directory}/{image["image_id"]}-current.model-text.txt', small)]
                else:
                    data.append(p(raw))
        else:
            g = r['gemini']
            data.append(p('Dữ liệu Gemini đọc được', heading))
            for label, val in [('Nhà cung cấp', g['supplier']['name']), ('Điện thoại', g['supplier']['phone']), ('Địa chỉ', g['supplier']['address']), ('Mã số thuế', g['supplier']['tax_code']), ('Số chứng từ', g['invoice']['number']), ('Ngày chứng từ', g['invoice']['date']), ('Tổng tiền trên chứng từ', g['total_amount'])]:
                data.append(p(f'{label}: {value(val)}'))
            data.append(p('null = không có/không đọc được. Không tự tính hoặc phân bổ tiền.', small))
            if r.get('pipeline_result') != g:
                data.append(p('Luồng SAPI có bộ lọc bên mua. Bảng này vẫn giữ dữ liệu Gemini gốc; kết quả sau bộ lọc nằm trong pipeline_result của JSON.', small))
        with PILImage.open(source) as original:
            picture = ImageOps.exif_transpose(original).convert('RGB')
            width, height = picture.size
            stream = io.BytesIO()
            picture.save(stream, format='PNG')  # Lossless report embedding, originals untouched.
        def photo(maxw, maxh):
            ratio = min(maxw/width, maxh/height)
            return Image(io.BytesIO(stream.getvalue()), width=width*ratio, height=height*ratio, hAlign='CENTER')
        def item_table(available_width):
            rows = [[p(image['image_id'] + ' - Dòng hàng', small)] + ['']*5, [p(t, small) for t in ['STT', 'Tên hàng', 'Đơn vị', 'Số lượng', 'Đơn giá', 'Thành tiền']]]
            if r and r['status'] == 'success':
                for number, item in enumerate(r['gemini']['items'], 1):
                    rows.append([p(number), p(value(item['name'])), p(value(item['unit'])), p(value(item['quantity']), numeric), p(value(item['unit_price']), numeric), p(value(item['total_price']), numeric)])
            if len(rows) == 2:
                rows.append([p('Không có dòng hàng trích xuất.')] + ['']*5)
            fractions = [.06, .36, .10, .12, .18, .18]
            table = Table(rows, colWidths=[available_width*x for x in fractions], repeatRows=2, hAlign='LEFT', splitInRow=1)
            commands = [('SPAN',(0,0),(-1,0)), ('BACKGROUND',(0,0),(-1,1),colors.HexColor('#e8f0fa')), ('VALIGN',(0,0),(-1,-1),'TOP'), ('GRID',(0,1),(-1,-1),.35,colors.HexColor('#ccd4df')), ('LEFTPADDING',(0,0),(-1,-1),5), ('RIGHTPADDING',(0,0),(-1,-1),5), ('BOTTOMPADDING',(0,0),(-1,-1),6), ('TOPPADDING',(0,0),(-1,-1),6)]
            if len(rows) == 3 and not (r and r['status'] == 'success' and r['gemini']['items']):
                commands.append(('SPAN',(0,2),(-1,2)))
            table.setStyle(TableStyle(commands))
            return table
        # Prefer side-by-side only when the image remains at least 360 pt wide
        # and all extracted data fits with 10pt type. Otherwise use full pages.
        side_width = 370
        available_h = landscape(A4)[1]-2*MARGIN
        thumb = photo(side_width, available_h-90)
        data_width = landscape(A4)[0]-2*MARGIN-side_width-16
        table = item_table(data_width)
        measured = sum(flow.wrap(data_width, 10000)[1] + getattr(flow, 'spaceAfter', 0) for flow in data) + table.wrap(data_width, 10000)[1]
        side = thumb.drawWidth >= 360 and measured < available_h-90
        template = 'landscape' if side else 'portrait'
        if index:
            story.extend([NextPageTemplate(template), PageBreak()])
        elif side:
            # BaseDocTemplate starts with template index 0; NextPageTemplate
            # only affects later pages, so put the first selected size first.
            doc.pageTemplates.reverse()
        story.extend(info)
        if side:
            content = Table([[thumb, data + [table]]], colWidths=[side_width+8, data_width+8])
            content.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'), ('LEFTPADDING',(0,0),(-1,-1),0)]))
            story.append(content)
        else:
            info_height = sum(flow.wrap(A4[0]-2*MARGIN, 10000)[1] + getattr(flow, 'spaceAfter', 0) for flow in info)
            # Leave enough frame slack for paragraph spacing and image layout;
            # otherwise the photo can move alone to the following page.
            story.append(photo(A4[0]-2*MARGIN, A4[1]-2*MARGIN-info_height-52))
            story.append(PageBreak())
            story.extend([p(title + ' - Kết quả', heading)] + data + [Spacer(1,8), item_table(A4[0]-2*MARGIN)])
    doc.build(story)
    print(str(output))
    return output

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-dir', type=Path, required=True)
    args = parser.parse_args()
    render(args.run_dir.resolve())
