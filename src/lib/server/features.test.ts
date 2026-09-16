import { describe, expect, test } from 'bun:test';
import { effectiveFeatures, featureBlocker, parseAllowances, parseSwitches } from './features';

const allowAll = { allowStats: true, allowPublicStatus: true, allowPublicStats: true };
const allOn = { statsEnabled: true, publicStatus: true, publicStats: true };

describe('effectiveFeatures', () => {
	test('both levels on', () => {
		expect(effectiveFeatures(allowAll, allOn)).toEqual({
			stats: true,
			publicStatus: true,
			publicStats: true
		});
	});
	test('the site owner wins', () => {
		expect(effectiveFeatures({ ...allowAll, allowStats: false }, allOn)).toEqual({
			stats: false,
			publicStatus: true,
			publicStats: false
		});
		expect(effectiveFeatures({ ...allowAll, allowPublicStatus: false }, allOn).publicStatus).toBe(
			false
		);
	});
	test('the server switch wins', () => {
		expect(effectiveFeatures(allowAll, { ...allOn, publicStats: false }).publicStats).toBe(false);
		expect(effectiveFeatures(allowAll, { ...allOn, statsEnabled: false })).toEqual({
			stats: false,
			publicStatus: true,
			publicStats: false
		});
	});
	test('public stats need stats', () => {
		expect(
			effectiveFeatures(allowAll, { statsEnabled: false, publicStatus: false, publicStats: true })
				.publicStats
		).toBe(false);
	});
});

describe('featureBlocker', () => {
	test('nothing to explain when off or fully on', () => {
		expect(featureBlocker('stats', allowAll, allOn)).toBeNull();
		expect(featureBlocker('stats', allowAll, { ...allOn, statsEnabled: false })).toBeNull();
	});
	test('names the site owner', () => {
		expect(featureBlocker('publicStatus', { ...allowAll, allowPublicStatus: false }, allOn)).toBe(
			'not allowed for this organisation by the site owner'
		);
	});
	test('names the missing stats', () => {
		expect(featureBlocker('publicStats', allowAll, { ...allOn, statsEnabled: false })).toBe(
			'needs match statistics, which are off'
		);
	});
});

describe('parsers', () => {
	test('only the keys present, coerced to booleans', () => {
		expect(parseSwitches({ statsEnabled: 0, publicStats: 'yes' })).toEqual({
			statsEnabled: false,
			publicStats: true
		});
		expect(parseAllowances({})).toEqual({});
		expect(parseAllowances({ allowPublicStatus: null })).toEqual({ allowPublicStatus: false });
	});
});
