#!/usr/bin/env python3
"""Writes www/ota.json: the list of app scripts (in index.html order) with SHA-256, used by the phone app to self-update from the website."""
import re, json, hashlib, sys, time, os
www = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'www')
html = open(os.path.join(www, 'index.html'), encoding='utf-8').read()
skip = {'js/guard.js', 'js/ota.js', 'js/webgate.js'}
paths = [p for p in re.findall(r'<script src="(js/[^"]+)"', html) if p not in skip]
def entry(p):
    b = open(os.path.join(www, p), 'rb').read()
    return {'path': p, 'sha': hashlib.sha256(b).hexdigest(), 'size': len(b)}
out = {'version': int(time.time()), 'files': [entry(p) for p in paths], 'css': entry('css/app.css')}
json.dump(out, open(os.path.join(www, 'ota.json'), 'w'), indent=1)
print('ota.json:', len(paths), 'scripts, version', out['version'])
