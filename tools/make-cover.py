"""生成大赛封面图 1080×720（无水印，JPG/PNG）"""
import os, math, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1080, 720
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

CN_FONTS = [
    r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arialbd.ttf",
]
def font(size, bold=True):
    for p in ([CN_FONTS[0], CN_FONTS[2]] if bold else [CN_FONTS[1], CN_FONTS[3]]):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

# ---------- 背景：深色渐变 + 光晕 ----------
img = Image.new("RGB", (W, H), (10, 20, 34))
px = img.load()
c1, c2, c3 = (10, 22, 38), (16, 42, 58), (8, 16, 28)
for y in range(H):
    for x in range(W):
        t = y / H
        base = lerp(c1, c3, t)
        # 左上角青色光晕
        d = math.hypot(x - 120, y - 40) / 620
        glow = max(0.0, 1 - d) ** 2
        px[x, y] = lerp(base, (34, 150, 138), glow * 0.30)
# 网格
d = ImageDraw.Draw(img, "RGBA")
for x in range(0, W, 40):
    d.line([(x, 0), (x, H)], fill=(255, 255, 255, 7))
for y in range(0, H, 40):
    d.line([(0, y), (W, y)], fill=(255, 255, 255, 7))

# ---------- 右侧模拟界面卡 ----------
card_x, card_y, card_w, card_h = 560, 96, 470, 500
shadow = Image.new("RGBA", (card_w + 80, card_h + 80), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
sd.rounded_rectangle([40, 40, 40 + card_w, 40 + card_h], 22, fill=(0, 0, 0, 150))
shadow = shadow.filter(ImageFilter.GaussianBlur(22))
img.paste(Image.alpha_composite(img.convert("RGBA"),
          Image.new("RGBA", img.size, (0, 0, 0, 0))).convert("RGB"), (0, 0)) if False else None
img_rgba = img.convert("RGBA")
img_rgba.alpha_composite(shadow, (card_x - 40, card_y - 40))
img = img_rgba.convert("RGB")
d = ImageDraw.Draw(img, "RGBA")

# 卡片体
d.rounded_rectangle([card_x, card_y, card_x + card_w, card_y + card_h], 20,
                    fill=(20, 34, 54, 255), outline=(42, 68, 96, 255), width=2)
# 顶栏
d.rounded_rectangle([card_x, card_y, card_x + card_w, card_y + 46], 20, fill=(26, 44, 68, 255))
d.rectangle([card_x, card_y + 30, card_x + card_w, card_y + 46], fill=(26, 44, 68, 255))
for i, col in enumerate([(226, 87, 76), (224, 163, 62), (53, 192, 122)]):
    d.ellipse([card_x + 16 + i * 18, card_y + 17, card_x + 27 + i * 18, card_y + 28], fill=col)
d.text((card_x + 84, card_y + 14), "智圃 · AI 校园管理系统", font=font(15, False), fill=(150, 176, 200))

# 侧边栏
side_w = 108
d.rounded_rectangle([card_x, card_y + 46, card_x + side_w, card_y + card_h], 0, fill=(16, 28, 44, 255))
for i in range(7):
    yy = card_y + 70 + i * 34
    if i == 1:
        d.rounded_rectangle([card_x + 10, yy - 6, card_x + side_w - 10, yy + 18], 7, fill=(30, 60, 76, 255))
    d.rounded_rectangle([card_x + 20, yy, card_x + 28, yy + 10], 3, fill=(60, 110, 130) if i != 1 else (55, 179, 162))
    d.rounded_rectangle([card_x + 36, yy + 2, card_x + 88, yy + 8], 3, fill=(52, 80, 104) if i != 1 else (120, 190, 180))

# 四个统计卡
sx, sy = card_x + side_w + 22, card_y + 70
for i in range(4):
    x = sx + (i % 2) * 168
    y = sy + (i // 2) * 78
    d.rounded_rectangle([x, y, x + 152, y + 64], 12, fill=(24, 40, 62, 255), outline=(40, 66, 94, 255))
    d.text((x + 14, y + 10), ["学生 240", "教师 36", "班级 12", "成绩 720"][i], font=font(14, False), fill=(148, 172, 196))
    d.text((x + 14, y + 30), ["在册", "在职", "教学班", "条记录"][i], font=font(11, False), fill=(86, 112, 138))

# 图表区（柱状）
gx, gy, gw, gh = sx, sy + 170, 320, 120
d.rounded_rectangle([gx, gy, gx + gw, gy + gh], 12, fill=(24, 40, 62, 255), outline=(40, 66, 94, 255))
d.text((gx + 14, gy + 10), "学科平均分", font=font(13, False), fill=(148, 172, 196))
bars = [75, 75, 76]
for i, v in enumerate(bars):
    bx = gx + 26 + i * 92
    bh = int((v / 100) * 62)
    d.rounded_rectangle([bx, gy + gh - 22 - bh, bx + 46, gy + gh - 22], 6, fill=(55, 179, 162, 235))
    d.text((bx + 8, gy + gh - 20), ["语文", "数学", "英语"][i], font=font(10, False), fill=(120, 146, 172))
    lbl=str(v); lw=d.textlength(lbl, font=font(10, False)); d.text((bx + (46 - lw)/2, gy + gh - 40 - bh), lbl, font=font(10, False), fill=(200, 226, 220))

# 表格区
tx, ty, tw = sx, gy + gh + 16, 320
d.rounded_rectangle([tx, ty, tx + tw, ty + 96], 12, fill=(24, 40, 62, 255), outline=(40, 66, 94, 255))
rows = ["2026", "2026", "2026", "2026"]
for i in range(4):
    yy = ty + 14 + i * 20
    d.rounded_rectangle([tx + 14, yy, tx + 46, yy + 8], 4, fill=(70, 110, 130))
    d.rounded_rectangle([tx + 58, yy, tx + 150, yy + 8], 4, fill=(54, 86, 108))
    d.rounded_rectangle([tx + 162, yy, tx + 210, yy + 8], 4, fill=(48, 120, 108))
    d.rounded_rectangle([tx + 226, yy, tx + 300, yy + 8], 4, fill=(54, 86, 108))

# AI 气泡（贴在卡片右下外侧）
bx, by = card_x + 300, card_y + card_h - 56
d.rounded_rectangle([bx, by, bx + 218, by + 52], 14, fill=(28, 92, 84, 255), outline=(60, 160, 146, 255))
d.text((bx + 14, by + 8), "AI 助手：本学期成绩已汇总，", font=font(12, False), fill=(226, 244, 240))
d.text((bx + 14, by + 28), "3 个学科均分 75.4 / 75.4 / 76.3", font=font(12, False), fill=(226, 244, 240))

# ---------- 左侧文案 ----------
LX = 68
# 顶部小标
d.rounded_rectangle([LX, 74, LX + 246, 108], 17, fill=(30, 60, 70, 255), outline=(56, 140, 130, 200))
d.text((LX + 16, 82), "AI 应用开发类 · 参赛作品", font=font(14, False), fill=(150, 226, 214))

# 主标题
d.text((LX, 132), "智圃", font=font(76), fill=(240, 250, 252))
d.text((LX, 222), "AI 校园管理", font=font(52), fill=(238, 248, 250))
d.text((LX, 288), "系统", font=font(52), fill=(55, 179, 162))

# 副标题
for i, line in enumerate(["以 AI 助手为统一入口，打通学生、教师、班级、",
                          "成绩、通知、请假全流程；内网可用的三层回退架构。"]):
    d.text((LX, 368 + i * 30), line, font=font(18, False), fill=(160, 186, 208))

# 特性标签
tags = ["AES 加密通信", "扫码登录", "RBAC 服务端校验", "AI 三层回退", "35 项自动化测试"]
tx0, ty0 = LX, 452
x = tx0
for t in tags:
    w = int(d.textlength(t, font=font(13, False))) + 26
    if x + w > card_x - 30:
        x = tx0
        ty0 += 38
    d.rounded_rectangle([x, ty0, x + w, ty0 + 30], 15, fill=(22, 46, 58, 255), outline=(46, 96, 108, 255))
    d.text((x + 13, ty0 + 8), t, font=font(13, False), fill=(150, 208, 200))
    x += w + 10

# 底部信息
d.line([(LX, 606), (LX + 430, 606)], fill=(40, 74, 96), width=1)
d.text((LX, 620), "参赛者：杨泓　·　广州华商学院", font=font(15, False), fill=(132, 158, 180))
d.text((LX, 646), "「百度搭子杯」AI 应用创新大赛　·　2026.12", font=font(13, False), fill=(96, 122, 146))

# ---------- 输出 ----------
png = os.path.join(OUT_DIR, "cover-1080x720.png")
jpg = os.path.join(OUT_DIR, "cover-1080x720.jpg")
img.save(png, "PNG", optimize=True)
img.save(jpg, "JPEG", quality=94, subsampling=0)
print("saved:", png, os.path.getsize(png) // 1024, "KB")
print("saved:", jpg, os.path.getsize(jpg) // 1024, "KB")
print("size:", img.size)
