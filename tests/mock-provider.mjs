import http from 'node:http';
export async function mockProvider(port=0) {
  let mode='fallback';const calls=[];let active=0;
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/control') {let body='';for await(const chunk of req)body+=chunk;mode=JSON.parse(body).mode;calls.length=0;res.end('{}');return;}
    if(req.url==='/calls'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({calls,active}));return;}
    let body='';for await(const chunk of req)body+=chunk;
    const node=req.url.split('/')[1];calls.push({node,body:JSON.parse(body),authorization:req.headers.authorization});active++;res.on('close',()=>active--);
    if(mode==='parameters') {
      const p=JSON.parse(body);
      if(node==='A'||p.temperature>1||p.max_tokens>4096) {
        res.writeHead(node==='A'?403:400,{'Content-Type':'application/json'});
        res.end(JSON.stringify({error:{message:node==='A'?'预扣费额度失败':'temperature or max_tokens invalid',code:node==='A'?'insufficient_user_quota':'invalid_request_error'}}));return;
      }
    }
    const fail=()=>{res.writeHead(node==='A'?401:503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:node==='A'?'Invalid API key test-only-A':'Provider unavailable',code:node==='A'?'invalid_api_key':'unavailable'}}));};
    if(mode==='slow'){const t=setTimeout(fail,120000);res.on('close',()=>clearTimeout(t));return;}
    if(mode==='all-fail'||node==='A'||mode==='loop'&&calls.length<5){fail();return;}
    if(mode==='fallback'&&node==='B'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"DO NOT DISPLAY PARTIAL"}}]}\n\n');return;}
    if(mode==='embedded'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:{message:'embedded failure'}}));return;}
    const result={id:'mock-result',object:'chat.completion',model:'mock-'+node,choices:[{index:0,message:{role:'assistant',content:'完整回复验证通过。'},finish_reason:'stop'}]};
    if(!JSON.parse(body).stream){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const data=Buffer.from('data: '+JSON.stringify({id:'mock-result',choices:[{index:0,delta:{content:'完整回复验证通过。'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    for(let i=0;i<data.length;i+=7)res.write(data.subarray(i,i+7));res.end();
  });
  await new Promise(r=>server.listen(port,'127.0.0.1',r));
  return {server,url:`http://127.0.0.1:${server.address().port}`,calls,setMode(value){mode=value;calls.length=0;},close(){server.closeAllConnections();return new Promise(r=>server.close(r));}};
}
if(process.argv.includes('--serve')){const m=await mockProvider(9107);console.log(m.url);}
