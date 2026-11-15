# Test MES build

`mes.html` is generated from the latest **MES Demo** artifact:

    python3 build/build_mes.py <demo index.html> mes.html

- `sb_boot.js` — Supabase connection (login, projects/tasks, master data, write-back).
- Do not edit `mes.html` by hand; changes are overwritten on the next build.
