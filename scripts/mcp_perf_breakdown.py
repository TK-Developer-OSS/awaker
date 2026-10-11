#!/usr/bin/env python3
# Copyright 2026 TK <tk.oss.developer@gmail.com>
# SPDX-License-Identifier: Apache-2.0
# Generated with Claude Code (https://claude.com/claude-code)
"""
Where does the render time go?  Offline-bounce the loaded project, then switch features off one by one and
bounce again.  Needs the app running with MCP (`npm run dev:mcp`) and a project loaded; the project is
restored from a temporary save at the end.

    python scripts/mcp_perf_breakdown.py [path-to-save-the-project-copy]

`renderMs` is the wall time of the offline render through the whole GPU path (no audio device), so
"x realtime" = project seconds / render seconds.  Playback needs this comfortably above 1 (the goal for
serious use is far above: many times realtime with room for 100 tracks).
"""
import json
import sys
import tempfile
import time
import urllib.request

URL = 'http://127.0.0.1:7777/mcp'
_id = [0]


def call(tool, **args):
    _id[0] += 1
    body = json.dumps({'jsonrpc': '2.0', 'id': _id[0], 'method': 'tools/call',
                       'params': {'name': tool, 'arguments': args}}).encode()
    req = urllib.request.Request(URL, data=body, headers={'content-type': 'application/json'})
    r = json.loads(urllib.request.urlopen(req, timeout=600).read())
    if 'error' in r:
        raise RuntimeError(r['error'])
    res = r['result']
    if res.get('isError'):
        raise RuntimeError(res['content'][0]['text'])
    out = []
    for c in res['content']:
        if c['type'] == 'text':
            try:
                out.append(json.loads(c['text']))
            except Exception:
                out.append(c['text'])
    return out[0] if len(out) == 1 else out


def main():
    keep = sys.argv[1] if len(sys.argv) > 1 else tempfile.gettempdir() + '/perf_breakdown_project.awaker.json'
    call('transport', action='stop')
    call('project_save_file', path=keep)
    tracks = call('tracks_list')

    def bounce(label):
        b = call('bounce', tailSeconds=0)
        print('%-36s renderMs %7.0f   x%.1f realtime' % (label, b['renderMs'], b['seconds'] * 1000 / b['renderMs']), flush=True)

    try:
        bounce('A everything as loaded')
        n = len(call('project_get')['master']['inserts'])
        for i in range(n):
            call('insert_set', owner='master', index=i, bypass=True)
        bounce('B + master chain bypassed')
        for t in tracks:
            for j in range(len(t['inserts'])):
                call('insert_set', owner=t['id'], index=j, bypass=True)
        bounce('C + track inserts bypassed')
        for t in tracks:
            call('strip_set', track=t['id'], params={'eqOn': False})
        bounce('D + strip EQ off')
        for t in tracks:
            call('strip_set', track=t['id'], params={'comp': {'on': False}})
        bounce('E + strip comp off')
        for t in tracks:
            call('strip_set', track=t['id'], params={'drive': 0})
        bounce('F + strip drive 0')
        for t in tracks:
            call('strip_set', track=t['id'], bypass=True)
        bounce('G + strips fully bypassed (floor)')
    finally:
        call('project_load_file', path=keep)
        time.sleep(8)
        print('project restored from', keep)


if __name__ == '__main__':
    main()
