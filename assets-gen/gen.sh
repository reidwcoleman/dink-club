#!/bin/zsh
# usage: gen.sh name model args...
name=$1; shift; model=$1; shift
higgsfield generate create $model "$@" --wait --json > $name.json 2>$name.err
url=$(python3 -c "import json,sys;d=json.load(open('$name.json'));d=d[0] if isinstance(d,list) else d;import re;s=json.dumps(d);m=re.findall(r'https://[^\"]+\.(?:png|jpg|jpeg|webp|wav|mp3|ogg)',s);print(m[0] if m else '')")
[ -n "$url" ] && curl -sL "$url" -o "$name.${url##*.}" && echo "$name ok $url" || echo "$name FAILED"
