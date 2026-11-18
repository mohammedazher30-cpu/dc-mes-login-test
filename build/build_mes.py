# Builds the test MES (mes.html) from the latest MES Demo artifact.
# Parts: 1 login · 2 projects/tasks · 3 master data · 4 work orders · 5 operator terminal · 6 dispatch (Logistics)
import json,sys
SRC=sys.argv[1]; OUT=sys.argv[2]
src=open(SRC,encoding='utf-8').read()

def rep(old,new,count=1):
    global src
    assert old in src, 'anchor not found: '+old[:80]
    src=src.replace(old,new,count)

# supabase-js
qr='<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>'
rep(qr, qr+'\n<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>')
rep('<title>MES Demo</title>','<title>DC MES · Test (Supabase)</title>')
# home-screen app (tablet): manifest, icon, full-screen settings
rep('<title>DC MES · Test (Supabase)</title>','<title>DC MES · Test (Supabase)</title>\n<link rel="manifest" href="app/manifest.webmanifest">\n<meta name="theme-color" content="#00A754">\n<meta name="mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="DC MES">\n<meta name="apple-mobile-web-app-status-bar-style" content="default">\n<link rel="apple-touch-icon" href="app/icon-180.png">\n<link rel="icon" type="image/png" href="app/icon-192.png">')

# drop embedded Zoho Inventory list (raw materials now come from Supabase)
k='window.RAW_IMPORT='
i=src.index(k)+len(k)
obj,end=json.JSONDecoder().raw_decode(src,i)
src=src[:i]+'null'+src[end:]

# Dispatch (Logistics) on
if 'const HIDE_DISPATCH=true;' in src: src=src.replace('const HIDE_DISPATCH=true;','const HIDE_DISPATCH=false;',1)

# no browser-stored demo login
rep('let me=null;try{const u=localStorage.getItem(KEY+"_user");me=u?by(db.users,u)||null:null}catch(e){}','let me=null;')

tail='document.addEventListener("keydown",e=>{if(e.key==="Escape")closeModal()});\nrender();\n</script>'
boot=open(''+__import__('os').path.join(__import__('os').path.dirname(__file__),'sb_boot.js')+'',encoding='utf-8').read()
rep(tail,'document.addEventListener("keydown",e=>{if(e.key==="Escape")closeModal()});\n'+boot+'\n</script>')

# older iPads (Safari before 16.4) cannot parse regex lookbehind: rewrite the Arabic BIDI fix without it
_bo='const BIDI_RE=/(?<![⁦\\w])([A-Za-z0-9]+(?:[-–\\/:][A-Za-z0-9]+)+)(?![⁩\\w])/g;'
_bn='const BIDI_RE=/(^|[^⁦\\w])([A-Za-z0-9]+(?:[-–\\/:][A-Za-z0-9]+)+)(?![⁩\\w])/g;'
if _bo in src:
    src=src.replace(_bo,_bn).replace('v.replace(BIDI_RE,"⁦$1⁩")','v.replace(BIDI_RE,"$1⁦$2⁩")')
elif '(?<' in src:
    print('WARNING: regex lookbehind still in the page; old iPads will show a blank page')
open(OUT,'w',encoding='utf-8').write(src)
print('ok',len(src))
