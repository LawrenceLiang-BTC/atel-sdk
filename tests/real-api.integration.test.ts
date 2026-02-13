import { describe, it, expect } from 'vitest';
import { RealHttpTool } from '../src/index.js';

const runNetwork = process.env.ATEL_RUN_NETWORK_TESTS === '1';
const suite = runNetwork ? describe : describe.skip;

suite('real api integration', () => {
  it('fetches real external API data', async () => {
    const response = await RealHttpTool.get('https://jsonplaceholder.typicode.com/posts/1');
    expect(response.status).toBe(200);
    expect((response.body as { id?: number }).id).toBe(1);
  });
});
