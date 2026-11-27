"""用秒哒版真实截图合成大赛封面 1080×720"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1080, 720
BASE = os.path.dirname(os.path.abspath(__file__))
SHOT = os.path.join(BASE, "miaoda2", "03-AI对话.png")
OUT_DIR = os.path.dirname(BASE)

FONT_B = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_R = r"C:\Windows\Fonts\msyh.ttc"
def f(size, bold=True):
    p = FONT_B if bold else FONT_R
    return ImageFont.truetype(p, size) if os.path.exists(p) else ImageFont.load_default()

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

import math
img = Image.new("RGB", (W, H), (10, 20, 34))
px = img.load()
for y in range(H):
    for x in range(W):
        base = lerp((10, 22, 38), (8, 16, 28), y / H)
        d = math.hypot(x - 120, y - 40) / 640
        glow = max(0.0, 1 - d) ** 2
        px[x, y] = lerp(base, (34, 150, 138), glow * 0.28)

d = ImageDraw.Draw(img, "RGBA")
for x in range(0, W, 40):
    d.line([(x, 0), (x, H)], fill=(255, 255, 255, 6))
for y in range(0, H, 40):
    d.line([(0, y), (W, y)], fill=(255, 255, 255, 6))

# ---------- 右侧：真实截图卡片 ----------
card_w = 566
shot = Image.open(SHOT).convert("RGB")
shot = shot.crop((60, 0, shot.width, shot.height))  # 裁掉左侧图标栏，让内容更清晰
ratio = card_w / shot.width
card_h = int(shot.height * ratio)
shot_small = shot.resize((card_w, card_h), Image.LANCZOS)

# 圆角
radius = 16
mask = Image.new("L", (card_w, card_h), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, card_w, card_h], radius, fill=255)

card = Image.new("RGBA", (card_w, card_h), (0, 0, 0, 0))
card.paste(shot_small, (0, 0), mask)

# 边框
bd = ImageDraw.Draw(card)
bd.rounded_rectangle([0, 0, card_w - 1, card_h - 1], radius, outline=(50, 84, 112, 255), width=2)

# 阴影
shadow = Image.new("RGBA", (card_w + 120, card_h + 120), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([60, 60, 60 + card_w, 60 + card_h], radius, fill=(0, 0, 0, 165))
shadow = shadow.filter(ImageFilter.GaussianBlur(26))

cx = W - card_w - 56
cy = (H - card_h) // 2 + 6
img_rgba = img.convert("RGBA")
img_rgba.alpha_composite(shadow, (cx - 60, cy - 60))
img_rgba.alpha_composite(card, (cx, cy))
img = img_rgba.convert("RGB")
d = ImageDraw.Draw(img, "RGBA")

# ---------- 左侧文案 ----------
LX = 66
# 赛道标
d.rounded_rectangle([LX, 70, LX + 250, 104], 17, fill=(30, 60, 70, 255), outline=(56, 140, 130, 220))
d.text((LX + 16, 78), "AI 应用开发类 · 参赛作品", font=f(14, False), fill=(150, 226, 214))

# 标题
d.text((LX, 128), "智圃", font=f(72), fill=(242, 250, 252))
d.text((LX, 212), "AI 校园管理系统", font=f(46), fill=(238, 248, 250))

# 副标
d.text((LX, 282), "不用学菜单，一句话查数据、办审批", font=f(19, False), fill=(160, 190, 212))

# 分隔
d.line([(LX, 322), (LX + 420, 322)], fill=(44, 78, 100), width=1)

# 特性 4 条（对齐产品真实能力）
feats = [
    ("对话即入口", "打开就是 AI 助手，不必记菜单"),
    ("意图识别", "说「查五年级1班成绩」直接出结果"),
    ("结果卡片", "返回表格与统计，不是一段文字"),
    ("对话内办事", "请假在卡片上直接通过 / 驳回"),
]
y = 344
for t, s in feats:
    d.ellipse([LX, y + 6, LX + 7, y + 13], fill=(55, 179, 162))
    d.text((LX + 18, y), t, font=f(16), fill=(226, 244, 240))
    d.text((LX + 118, y + 2), s, font=f(14, False), fill=(140, 168, 192))
    y += 34

# 模块标签
tags = ["六大模块", "两级权限", "成绩统计", "移动端适配"]
x, ty = LX, 500
for t in tags:
    w = int(d.textlength(t, font=f(13, False))) + 24
    d.rounded_rectangle([x, ty, x + w, ty + 28], 14, fill=(22, 46, 58, 255), outline=(46, 96, 108, 255))
    d.text((x + 12, ty + 7), t, font=f(13, False), fill=(150, 208, 200))
    x += w + 9

# 底部
d.line([(LX, 592), (LX + 400, 592)], fill=(44, 78, 100), width=1)
d.text((LX, 606), "参赛者：杨泓　·　广州华商学院", font=f(15, False), fill=(136, 162, 184))
d.text((LX, 632), "「百度搭子杯」AI 应用创新大赛　·　2026.12", font=f(13, False), fill=(98, 124, 148))

png = os.path.join(OUT_DIR, "cover-final-1080x720.png")
jpg = os.path.join(OUT_DIR, "cover-final-1080x720.jpg")
img.save(png, "PNG", optimize=True)
img.save(jpg, "JPEG", quality=93, subsampling=0)
print("saved:", png, os.path.getsize(png) // 1024, "KB")
print("saved:", jpg, os.path.getsize(jpg) // 1024, "KB")
print("size:", img.size)
