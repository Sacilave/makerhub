#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, sys
from http.cookiejar import CookieJar
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, Request, build_opener
def request_json(opener,method,url,payload=None):
    body=None; headers={'Accept':'application/json'}
    if payload is not None: body=json.dumps(payload).encode(); headers['Content-Type']='application/json'
    with opener.open(Request(url,data=body,headers=headers,method=method),timeout=60) as response: data=json.loads(response.read().decode())
    if not isinstance(data,dict): raise RuntimeError(f'{url} did not return a JSON object')
    return data
def main():
    p=argparse.ArgumentParser(description='Read-only live canary for an already logged-in MakerHub instance.'); p.add_argument('--base-url',default='http://127.0.0.1:9042'); p.add_argument('--username',default='admin'); p.add_argument('--password',required=True); p.add_argument('--url',required=True); p.add_argument('--min-count',type=int,default=1); a=p.parse_args(); base=a.base_url.rstrip('/'); opener=build_opener(HTTPCookieProcessor(CookieJar()))
    try:
        login=request_json(opener,'POST',f'{base}/api/auth/login',{'username':a.username,'password':a.password});
        if login.get('success') is False: raise RuntimeError(f'MakerHub login rejected: {login}')
        ready=request_json(opener,'GET',f'{base}/api/public/health/ready'); preview=request_json(opener,'POST',f'{base}/api/archive/preview',{'url':a.url})
    except (HTTPError,URLError,TimeoutError,RuntimeError) as exc: print(f'live canary failed: {exc}',file=sys.stderr); return 1
    discovered=int(preview.get('discovered_count') or 0); expected=int(preview.get('expected_total') or 0); accepted=preview.get('accepted') is not False
    if not accepted: print(json.dumps(preview,ensure_ascii=False,indent=2),file=sys.stderr); return 2
    if discovered<max(a.min_count,0): print(f'live canary failed: discovered_count={discovered} < min_count={a.min_count}',file=sys.stderr); return 3
    if expected>0 and discovered!=expected: print(f'live canary failed: expected_total={expected}, discovered_count={discovered}',file=sys.stderr); return 4
    print(json.dumps({'ready':ready,'url':a.url,'accepted':accepted,'discovered_count':discovered,'expected_total':expected,'mode':preview.get('mode'),'message':preview.get('message'),'result':'PASS'},ensure_ascii=False,indent=2)); return 0
if __name__=='__main__': raise SystemExit(main())
