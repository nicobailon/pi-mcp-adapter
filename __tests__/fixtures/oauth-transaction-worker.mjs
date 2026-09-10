import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { auth } from '@modelcontextprotocol/client';
import { McpOAuthProvider } from '../../mcp-oauth-provider.ts';

const [name, url, store] = process.argv.slice(2);
class FixtureProvider extends McpOAuthProvider {
  invalidated = false;
  withAuthTransaction(operation) {
    const pending = super.withAuthTransaction(operation);
    process.send({ event: 'transaction-entered' });
    return pending;
  }
  async invalidateCredentials(scope) {
    if (scope === 'tokens') this.invalidated = true;
    await super.invalidateCredentials(scope);
  }
  async clientInformation() { return { client_id: 'fake-client', issuer: new URL(url).origin }; }
  async tokens() { return this.invalidated ? undefined : JSON.parse(readFileSync(store, 'utf8')); }
  async saveTokens(tokens) {
    const pending = `${store}.${process.pid}`;
    writeFileSync(pending, JSON.stringify(tokens));
    renameSync(pending, store);
  }
}
const provider = new FixtureProvider(name, url, {}, { onRedirect: async () => {} });
process.on('message', async message => {
  if (message !== 'auth') return;
  try {
    const result = await auth(provider, { serverUrl: url });
    process.send({ event: 'result', result });
  } catch (error) {
    process.send({ event: 'error', name: error.name });
  }
});
process.send({ event: 'ready' });
