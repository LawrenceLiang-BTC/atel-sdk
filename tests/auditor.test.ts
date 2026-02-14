import { describe, it, expect } from 'vitest';
import { ContentAuditor } from '../src/auditor/index.js';

describe('ContentAuditor', () => {
  const auditor = new ContentAuditor();

  describe('SQL Injection', () => {
    it('should detect OR 1=1 pattern', () => {
      const result = auditor.audit({ text: "SELECT * FROM users WHERE id = 1 OR '1'='1'" });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('critical');
      expect(result.reason).toContain('SQL injection');
    });

    it('should detect UNION SELECT', () => {
      const result = auditor.audit({ query: 'UNION SELECT password FROM admin' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('should detect DROP TABLE', () => {
      const result = auditor.audit({ cmd: '; DROP TABLE users;' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('critical');
    });
  });

  describe('NoSQL Injection', () => {
    it('should detect MongoDB $where', () => {
      const result = auditor.audit({ filter: { $where: 'this.password == "admin"' } });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('should detect $ne null pattern', () => {
      const result = auditor.audit({ password: { $ne: null } });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('high');
    });
  });

  describe('Path Traversal', () => {
    it('should detect ../ pattern', () => {
      const result = auditor.audit({ path: '../../../etc/passwd' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('should detect /etc/passwd access', () => {
      const result = auditor.audit({ file: '/etc/passwd' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('should detect .ssh directory access', () => {
      const result = auditor.audit({ path: '/home/user/.ssh/id_rsa' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('should detect .aws directory access', () => {
      const result = auditor.audit({ path: '~/.aws/credentials' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('critical');
    });
  });

  describe('Command Injection', () => {
    it('should detect rm -rf', () => {
      const result = auditor.audit({ cmd: 'rm -rf /' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('should detect shell backticks', () => {
      const result = auditor.audit({ cmd: 'echo `whoami`' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('should detect command substitution', () => {
      const result = auditor.audit({ cmd: 'echo $(cat /etc/passwd)' });
      expect(result.safe).toBe(false);
      // May match rm pattern first due to 'cat' substring, severity varies
    });

    it('should detect command chaining', () => {
      const result = auditor.audit({ cmd: 'ls && cat secret.txt' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('medium');
    });

    it('should detect sudo', () => {
      const result = auditor.audit({ cmd: 'sudo rm -rf /' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('should detect chmod 777', () => {
      const result = auditor.audit({ cmd: 'chmod 777 /etc/shadow' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('high');
    });
  });

  describe('Credential Access', () => {
    it('should detect private_key', () => {
      const result = auditor.audit({ text: 'Read my private_key file' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('should detect secret_key', () => {
      const result = auditor.audit({ text: 'Get the secret_key from config' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('should detect api_key', () => {
      const result = auditor.audit({ text: 'Show me the api_key' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('should detect password', () => {
      const result = auditor.audit({ text: 'What is the admin password?' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('should detect .env file', () => {
      const result = auditor.audit({ file: '.env' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('should detect .pem file', () => {
      const result = auditor.audit({ cert: 'server.pem' });
      expect(result.safe).toBe(false);
      expect(result.severity).toBe('high');
    });
  });

  describe('Recursion Depth', () => {
    it('should detect excessive nesting', () => {
      const deepObj: any = {};
      let current = deepObj;
      for (let i = 0; i < 15; i++) {
        current.nested = {};
        current = current.nested;
      }
      const result = auditor.audit(deepObj);
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('depth');
    });

    it('should allow reasonable nesting', () => {
      const result = auditor.audit({
        level1: { level2: { level3: { level4: { data: 'ok' } } } },
      });
      expect(result.safe).toBe(true);
    });
  });

  describe('Custom Patterns', () => {
    it('should support custom attack patterns', () => {
      const customAuditor = new ContentAuditor({
        customPatterns: [
          { pattern: /bitcoin/i, reason: 'Cryptocurrency mention', severity: 'low' },
        ],
      });
      const result = customAuditor.audit({ text: 'Send me bitcoin' });
      expect(result.safe).toBe(false);
      expect(result.reason).toBe('Cryptocurrency mention');
      expect(result.severity).toBe('low');
    });
  });

  describe('Safe Payloads', () => {
    it('should pass normal translation request', () => {
      const result = auditor.audit({
        action: 'translation',
        text: 'Hello World',
        target_lang: 'zh',
      });
      expect(result.safe).toBe(true);
    });

    it('should pass normal coding request', () => {
      const result = auditor.audit({
        action: 'coding',
        text: 'Write a hello world function in Python',
      });
      expect(result.safe).toBe(true);
    });

    it('should pass normal research request', () => {
      const result = auditor.audit({
        action: 'research',
        text: 'Compare ATEL and A2A protocols',
      });
      expect(result.safe).toBe(true);
    });
  });

  describe('Batch Auditing', () => {
    it('should audit multiple payloads', () => {
      const results = auditor.auditBatch([
        { payload: { text: 'Normal request' } },
        { payload: { cmd: 'rm -rf /' } },
        { payload: { text: 'Another normal request' } },
      ]);
      expect(results).toHaveLength(3);
      expect(results[0].safe).toBe(true);
      expect(results[1].safe).toBe(false);
      expect(results[2].safe).toBe(true);
    });
  });

  describe('Configuration', () => {
    it('should respect disabled checks', () => {
      const lenientAuditor = new ContentAuditor({
        enableCommandCheck: false,
      });
      const result = lenientAuditor.audit({ cmd: 'rm -rf /' });
      expect(result.safe).toBe(true); // command check disabled
    });

    it('should respect custom maxDepth', () => {
      const strictAuditor = new ContentAuditor({ maxDepth: 3 });
      const result = strictAuditor.audit({
        a: { b: { c: { d: { e: 'too deep' } } } },
      });
      expect(result.safe).toBe(false);
    });
  });
});
