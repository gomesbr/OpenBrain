Set-Location "c:\Users\Fabio\Cursor AI projects\Projects\OpenBrain"
npm run metadata:queue:worker -- --chat=personal.main --source=chatgpt --workers=3 --claim=6 --context=14 --strict-errors=0 --row-retries=4 --retry-backoff-ms=1800 --poll-ms=900 --idle-seconds=20
npm run metadata:queue:worker -- --chat=personal.main --source=grok --workers=3 --claim=6 --context=14 --strict-errors=0 --row-retries=4 --retry-backoff-ms=1800 --poll-ms=900 --idle-seconds=20
npm run metadata:queue:progress -- --chat=personal.main --source=chatgpt
npm run metadata:queue:progress -- --chat=personal.main --source=grok
