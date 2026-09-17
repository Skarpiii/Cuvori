#!/usr/bin/env python3
"""Recompute the Content-Security-Policy <meta> of index.html.
Every inline <script> is allowed by its SHA-256 hash, so any script an attacker manages to inject
(inline handler, <script>, javascript: link) is refused by the browser.
Run this after EVERY change to index.html:  python3 tools/csp.py index.html"""
import base64, hashlib, re, sys
args = [a for a in sys.argv[1:] if a != "--check"]
check = "--check" in sys.argv
path = args[0] if args else "index.html"
s = open(path, encoding="utf-8").read()
hashes = []
for m in re.finditer(r"<script>(.*?)</script>", s, re.S):
    hashes.append("'sha256-" + base64.b64encode(hashlib.sha256(m.group(1).encode("utf-8")).digest()).decode() + "'")
SB = "tnxujwlfatcvxzevllfr.supabase.co"
policy = "; ".join([
    "default-src 'self'",
    "script-src " + " ".join(hashes) + " https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data: blob:",
    "media-src 'self' https: data: blob:",
    "font-src 'self' data:",
    f"connect-src 'self' https://{SB} wss://{SB}",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
])
tag = f'<meta http-equiv="Content-Security-Policy" content="{policy}" />'
if 'http-equiv="Content-Security-Policy"' in s:
    s = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>', lambda _: tag, s, count=1)
else:
    s = s.replace('<meta charset="utf-8" />', '<meta charset="utf-8" />\n  ' + tag + '\n  <meta name="referrer" content="strict-origin-when-cross-origin" />', 1)
if check:
    same = open(path, encoding="utf-8").read() == s
    print("CSP is up to date" if same else "CSP is OUT OF DATE - run: python3 tools/csp.py index.html")
    sys.exit(0 if same else 1)
open(path, "w", encoding="utf-8").write(s)
print(f"CSP updated with {len(hashes)} script hashes")
