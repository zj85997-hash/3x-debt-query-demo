from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

pdfmetrics.registerFont(TTFont('DemoCJK', '/Library/Fonts/Arial Unicode.ttf'))
dest = Path('fixtures/债权转让通知-虚构样本.pdf')
c = Canvas(str(dest), pagesize=A4)
c.setTitle('债权转让通知 虚构样本')
c.setAuthor('项目演示')
c.setFillColorRGB(.07,.27,.23)
c.setFont('DemoCJK',22)
c.drawString(46,782,'债权转让通知 虚构样本')
c.setFillColorRGB(.2,.3,.28)
c.setFont('DemoCJK',11)
c.drawString(46,747,'仅用于模拟查询。本页机构、姓名、证件尾号均为虚构测试资料。')
columns=[46,158,304,423]
rows=[
 ('借款人姓名','证件号码（脱敏）','公告编号','公告日期'),
 ('样例甲','**************0067','DEMO-FIX-001','2025-06-17'),
 ('样例甲','**************7021','DEMO-FIX-002','2025-05-30'),
 ('样例重名','**************8042','DEMO-FIX-003','2025-05-29'),
 ('样例重名','**************8042','DEMO-FIX-004','2025-04-14'),
 ('样例乙','**************351X','DEMO-FIX-005','2025-04-21')
]
for i,row in enumerate(rows):
 y=695-i*32
 c.setFillColorRGB(.90,.94,.92) if i==0 else c.setFillColorRGB(.97,.98,.97)
 c.rect(42,y-10,510,31,fill=1,stroke=0)
 c.setFillColorRGB(.10,.20,.18)
 for x,value in zip(columns,row):
  c.drawString(x,y,value)
c.setFillColorRGB(.35,.40,.40)
c.drawString(46,59,'虚构样本 · 2026年11月11日')
c.save()
