import extract from 'extract-zip';
const wd = setTimeout(()=>{console.error('EXTRACT HUNG 60s'); process.exit(99);}, 60000);
const t0 = Date.now();
try { await extract('/Users/petreluca/Library/Caches/electron/6cd2772972335ab2f4c0b953c4629abf8fdd4e8c40a78ee5416e18109dc552b1/electron-v42.0.1-darwin-arm64.zip', { dir: '/tmp/ez-out' }); console.log('EXTRACT_OK in', Date.now()-t0,'ms'); clearTimeout(wd);}
catch(e){ console.error('EXTRACT_THREW', e?.stack||e); clearTimeout(wd); process.exit(1);}
