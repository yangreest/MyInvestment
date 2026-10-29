# -*- coding: utf-8 -*-
"""定投记录网站 - 静态文件 + 基金实时估值代理服务器（仅用Python标准库）

启动方式：python server.py  然后访问 http://localhost:8080
估值数据来源：天天基金移动端公开接口（盘中有实时估算GSZ时用估算，否则用最新确认净值NAV）
纸黄金行情：新浪财经上金所 Au99.99 现货实价（银行纸黄金基本跟踪此价，元/克）
"""
import json
import re
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8080
BASE_DIR = Path(__file__).resolve().parent
FUND_API_URL = ("https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo"
                "?pageIndex=1&pageSize=1&plat=Android&appType=ttjj&product=EFund"
                "&Version=1&deviceid=1&Fcodes={code}")
GOLD_URL = "https://hq.sinajs.cn/list=gds_AU9999"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def do_GET(self):
        path = self.path.split("?")[0]
        # /api/fundest/110020 -> 代理天天基金估值接口
        m = re.match(r"^/api/fundest/(\d{6})$", path)
        if m:
            self.proxy_fundest(m.group(1))
        elif path == "/api/gold":
            # /api/gold -> 代理上金所 Au99.99 金价（纸黄金用）
            self.proxy_gold()
        else:
            super().do_GET()

    def _send_json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def proxy_gold(self):
        try:
            req = urllib.request.Request(
                GOLD_URL,
                headers={"Referer": "https://finance.sina.com.cn",
                         "User-Agent": "Mozilla/5.0"},
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                text = resp.read().decode("gbk", errors="replace")
            payload = text.split('"')[1]
            f = payload.split(",")
            price = float(f[0])          # 最新价 元/克
            prev = float(f[7])           # 前收盘参考价
            if price <= 0:
                raise ValueError("no price")
            self._send_json({
                "ok": True,
                "name": "上金所 Au99.99",
                "price": price,
                "prevclose": prev,
                "gszzl": f"{(price - prev) / prev * 100:.2f}" if prev else "0",
                "gztime": f"{f[12]} {f[6]}",
                "unit": "元/克",
            })
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)})

    def proxy_fundest(self, code):
        try:
            req = urllib.request.Request(
                FUND_API_URL.format(code=code),
                headers={"User-Agent": "Mozilla/5.0"},
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            items = data.get("Datas") or []
            if not items:
                raise ValueError("empty")
            d = items[0]
            # 盘中有实时估算(GSZ)优先用估算，否则用最新确认净值(NAV)
            has_gz = d.get("GSZ") not in (None, "", "0")
            nav = d.get("GSZ") if has_gz else d.get("NAV")
            chg = d.get("GSZZL") if has_gz else d.get("NAVCHGRT")
            gztime = d.get("GZTIME") if has_gz and d.get("GZTIME") else d.get("PDATE")
            if nav in (None, ""):
                raise ValueError("no nav")
            self._send_json({
                "ok": True,
                "code": d.get("FCODE", code),
                "name": d.get("SHORTNAME", ""),
                "gsz": str(nav),                # 估算净值或最新确认净值
                "gszzl": str(chg or "0"),       # 对应涨跌幅 %
                "gztime": str(gztime or ""),    # 净值/估值日期时间
                "mode": "估算" if has_gz else "确认净值",
                "dwjz": str(d.get("NAV") or ""),
            })
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)})

    def log_message(self, fmt, *args):
        # 减少静态文件请求的日志噪音，只保留API日志
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"定投记录网站已启动: http://localhost:{PORT}")
    print(f"估值代理接口: http://localhost:{PORT}/api/fundest/<6位基金代码>")
    print("按 Ctrl+C 停止服务")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
