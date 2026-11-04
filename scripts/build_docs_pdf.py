"""Generate Korean PDF companions from categorized Markdown using ReportLab.
PDFs are published to the same category directory as each Markdown file.
"""
from pathlib import Path
import re
import html
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Preformatted, KeepTogether
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

ROOT = Path(__file__).resolve().parents[1]
FONT_CANDIDATES = [
    Path('/usr/share/fonts/truetype/nanum/NanumGothic.ttf'),
    Path('/usr/share/fonts/truetype/nanum/NanumBarunGothic.ttf'),
    Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
]
font = next((p for p in FONT_CANDIDATES if p.exists()), None)
if font:
    pdfmetrics.registerFont(TTFont('DocFont', str(font)))
else:
    raise RuntimeError('Please install fonts-nanum before building PDFs')

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='DocTitle', fontName='DocFont', fontSize=19, leading=30, spaceAfter=18, textColor=colors.HexColor('#183451')))
styles.add(ParagraphStyle(name='DocH2', fontName='DocFont', fontSize=13, leading=22, spaceBefore=14, spaceAfter=7, textColor=colors.HexColor('#183451')))
styles.add(ParagraphStyle(name='DocH3', fontName='DocFont', fontSize=11, leading=19, spaceBefore=10, spaceAfter=5, textColor=colors.HexColor('#2563EB')))
styles.add(ParagraphStyle(name='DocBody', fontName='DocFont', fontSize=9.5, leading=17, spaceAfter=6, wordWrap='CJK'))
styles.add(ParagraphStyle(name='DocCode', fontName='DocFont', fontSize=7.5, leading=11.5, spaceAfter=4, wordWrap='CJK'))
styles.add(ParagraphStyle(name='DocSub', fontName='DocFont', fontSize=9, leading=14, textColor=colors.HexColor('#667085')))

def inline(src):
    s = html.escape(src)
    s = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', s)
    s = re.sub(r'`([^`]+)`', r'<font color="#2757A3">\1</font>', s)
    s = re.sub(r'\[([^]]+)\]\(([^)]+)\)', r'\1', s)
    return s

def build_one(path):
    target = path.with_suffix('.pdf')
    doc = SimpleDocTemplate(str(target), pagesize=A4, topMargin=44, bottomMargin=48,
                            leftMargin=48, rightMargin=48,
                            title=path.stem, author='ContentFlow AI')
    flow = []
    code = False
    buffer = []
    def flush_code():
        nonlocal buffer
        if buffer:
            for line in buffer:
                flow.append(Paragraph(inline(line or ' '), styles['DocCode']))
            flow.append(Spacer(1, 7))
        buffer = []
    for raw in path.read_text(encoding='utf-8').splitlines():
        s = raw.strip()
        if s.startswith('```'):
            if code:
                flush_code()
            code = not code
            continue
        if code:
            buffer.append(raw)
            continue
        if not s:
            flow.append(Spacer(1, 4))
        elif s.startswith('# '):
            flow.append(Paragraph(inline(s[2:]), styles['DocTitle']))
        elif s.startswith('## '):
            flow.append(Paragraph(inline(s[3:]), styles['DocH2']))
        elif s.startswith('### '):
            flow.append(Paragraph(inline(s[4:]), styles['DocH3']))
        elif s.startswith('|'):
            # Tables remain readable as sequential rows even on A4.
            if not re.fullmatch(r'[|:\-\s]+', s):
                cells = [x.strip() for x in s.strip('|').split('|')]
                flow.append(Paragraph('  /  '.join(inline(x) for x in cells), styles['DocBody']))
        else:
            flow.append(Paragraph(inline(s), styles['DocBody']))
    if code:
        flush_code()
    def footer(canvas, document):
        canvas.saveState()
        canvas.setFont('DocFont', 8)
        canvas.setFillColor(colors.HexColor('#667085'))
        canvas.drawString(48, 27, 'ContentFlow AI v2.0')
        canvas.drawRightString(A4[0]-48, 27, str(document.page))
        canvas.restoreState()
    doc.build(flow, onFirstPage=footer, onLaterPages=footer)
    print(target.relative_to(ROOT), target.stat().st_size)

if __name__ == '__main__':
    for p in sorted((ROOT / 'docs').glob('*/*.md')):
        build_one(p)
