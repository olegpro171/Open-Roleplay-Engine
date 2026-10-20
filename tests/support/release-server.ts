// Controlled server entry for packaging/startup tests. The real application is
// exercised separately; these fixtures make readiness and failure deterministic.
export const releaseServer = `
import {createServer} from 'node:http';
const server=createServer((request,response)=>{
  response.setHeader('content-type',request.url==='/api/session'?'application/json':'text/html');
  response.end(request.url==='/api/session'?JSON.stringify({setupRequired:true}):'<title>ORE</title>');
});
server.listen(Number(process.env.ROLEPLAY_PORT),'127.0.0.1',()=>{
  const url='http://127.0.0.1:'+server.address().port;
  console.log('Local: '+url);
  process.send?.({type:'ready',url});
});
function stop(){server.close(()=>process.exit(0));}
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('disconnect',stop);
`;
