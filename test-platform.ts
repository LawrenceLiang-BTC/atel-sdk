import { AgentIdentity, serializePayload } from './src/identity/index.ts';
import { readFileSync } from 'fs';

const idData = JSON.parse(readFileSync('/Users/liangqianwei/.openclaw/workspace/.atel/identity.json','utf8'));
const identity = new AgentIdentity({
  publicKey: Uint8Array.from(Buffer.from(idData.publicKey,'base64')),
  secretKey: Uint8Array.from(Buffer.from(idData.secretKey,'base64')),
  agent_id: idData.agent_id
});

console.log('DID:', identity.did);

const payload = {
  did: identity.did,
  name: 'sea-agent',
  description: 'ATEL test on new platform',
  capabilities: [{type:'translate',description:'Translation'}],
  endpoint: 'http://localhost:3100',
  discoverable: true
};
const timestamp = new Date().toISOString();
const signable = serializePayload({payload, did: identity.did, timestamp});
const signature = identity.sign(signable);
const body = JSON.stringify({payload, did: identity.did, timestamp, signature});

async function main() {
  const resp = await fetch('http://127.0.0.1:8200/registry/v1/register', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body
  });
  const data = await resp.json();
  console.log('Status:', resp.status);
  console.log(JSON.stringify(data, null, 2));

  // Test search
  const searchResp = await fetch('http://127.0.0.1:8200/registry/v1/search');
  const searchData = await searchResp.json();
  console.log('\nSearch:', JSON.stringify(searchData, null, 2));

  // Test health
  const healthResp = await fetch('http://127.0.0.1:8200/health');
  const healthData = await healthResp.json();
  console.log('\nHealth:', JSON.stringify(healthData, null, 2));
}

main().catch(console.error);
