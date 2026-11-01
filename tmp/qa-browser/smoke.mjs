import http from 'node:http';
const get = url => new Promise(res => {
  http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res({ status: r.statusCode, size: b.length, body: b })); }).on('error', e => res({ error: e.message }));
});
(async () => {
  for (const screen of ['sales','quality','inventory']) {
    const r = await get('http://localhost:3000/?cloud=1&screen='+screen);
    console.log('\n===== '+screen.toUpperCase()+' ('+r.size+'):\n'+(r.error || r.body));
    if (r.error) throw new Error(screen+' GET failed: '+r.error);
  }
})().catch(e => { console.log('err', e.message); process.exit(2); });
