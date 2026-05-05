# SiteSureLabs

Quick share link (ngrok via nginx)
==================================

Run this from repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-share.ps1
```

If frontend is already built and you want faster start:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-share.ps1 -SkipBuild
```

It will:
- start backend on `127.0.0.1:8010` (if not running)
- validate/start nginx on `127.0.0.1:8080`
- start ngrok to nginx and print the public share URL


# Quick check command
Use this anytime to verify what’s actually running:

Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -in 2626,8080,8010} | Select LocalAddress,LocalPort













uvicorn main:app --host 127.0.0.1 --port 8010









cd backend
.venv/Scripts/activate
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8010

cd frontend
npm run dev



Database:
=========
- In powershell type this command, for mongodb

docker run -d `
  --name defectra-mongo `
  -p 27017:27017 `
  -v mongo_data:/data/db `
  mongo:7


Verify MongoDB is actually usable
---------------------------------

docker exec -it defectra-mongo mongosh
show dbs


