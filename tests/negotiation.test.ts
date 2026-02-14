import { describe, it, expect } from 'vitest';
import { NegotiationHandler, NegotiationClient } from '../src/negotiation/index.js';
import { AgentIdentity } from '../src/identity/index.js';

describe('Capability Negotiation', () => {
  describe('NegotiationHandler', () => {
    const handler = new NegotiationHandler({
      supportedTypes: ['flight_search', 'hotel_booking'],
      maxRiskLevel: 'medium',
      defaultScopes: ['tool:http:get', 'data:public_web:read'],
      defaultTtlSec: 3600,
      defaultMaxCalls: 50,
      estimateCost: (req) => {
        if (req.taskType === 'flight_search') return { cost: 0.5, currency: 'USD' };
        if (req.taskType === 'hotel_booking') return { cost: 1.0, currency: 'USD' };
        return null;
      },
      estimateDuration: (req) => {
        if (req.taskType === 'flight_search') return 5000;
        return 10000;
      },
    });

    it('should accept supported task types', () => {
      const result = handler.evaluate({
        taskType: 'flight_search',
        riskLevel: 'low',
      });

      expect(result.canHandle).toBe(true);
      expect(result.terms).toBeDefined();
      expect(result.terms!.estimatedCost).toBe(0.5);
      expect(result.terms!.estimatedDurationMs).toBe(5000);
      expect(result.terms!.requiredScopes).toContain('tool:http:get');
    });

    it('should reject unsupported task types', () => {
      const result = handler.evaluate({
        taskType: 'crypto_trading',
        riskLevel: 'low',
      });

      expect(result.canHandle).toBe(false);
      expect(result.reason).toContain('Unsupported task type');
    });

    it('should reject tasks exceeding risk level', () => {
      const result = handler.evaluate({
        taskType: 'flight_search',
        riskLevel: 'critical',
      });

      expect(result.canHandle).toBe(false);
      expect(result.reason).toContain('Risk level');
    });

    it('should reject tasks exceeding budget', () => {
      const result = handler.evaluate({
        taskType: 'hotel_booking',
        riskLevel: 'low',
        maxCost: 0.5, // Budget is 0.5 but hotel costs 1.0
      });

      expect(result.canHandle).toBe(false);
      expect(result.reason).toContain('Estimated cost');
    });

    it('should accept tasks within budget', () => {
      const result = handler.evaluate({
        taskType: 'flight_search',
        riskLevel: 'low',
        maxCost: 1.0,
      });

      expect(result.canHandle).toBe(true);
    });

    it('should support custom validators', () => {
      const strictHandler = new NegotiationHandler({
        supportedTypes: ['flight_search'],
        maxRiskLevel: 'high',
        defaultScopes: [],
        defaultTtlSec: 600,
        defaultMaxCalls: 10,
        customValidator: (req) => {
          if (req.constraints?.region === 'restricted') {
            return { valid: false, reason: 'Restricted region' };
          }
          return { valid: true };
        },
      });

      const result = strictHandler.evaluate({
        taskType: 'flight_search',
        riskLevel: 'low',
        constraints: { region: 'restricted' },
      });

      expect(result.canHandle).toBe(false);
      expect(result.reason).toBe('Restricted region');
    });
  });
});
