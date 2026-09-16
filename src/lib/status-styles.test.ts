import { describe, expect, test } from 'bun:test';
import {
	clampStatusInterval,
	DEFAULT_STATUS_INTERVAL,
	isStatusStyle,
	MAX_STATUS_INTERVAL,
	MIN_STATUS_INTERVAL
} from './status-styles';

describe('clampStatusInterval', () => {
	test('keeps a value in range', () => {
		expect(clampStatusInterval(60)).toBe(60);
		expect(clampStatusInterval(120)).toBe(120);
	});
	test('clamps to the 30..300 bounds', () => {
		expect(clampStatusInterval(5)).toBe(MIN_STATUS_INTERVAL);
		expect(clampStatusInterval(10_000)).toBe(MAX_STATUS_INTERVAL);
		expect(clampStatusInterval('45')).toBe(45);
	});
	test('a bad value falls back to the default', () => {
		expect(clampStatusInterval(undefined)).toBe(DEFAULT_STATUS_INTERVAL);
		expect(clampStatusInterval('nope')).toBe(DEFAULT_STATUS_INTERVAL);
		expect(clampStatusInterval(NaN)).toBe(DEFAULT_STATUS_INTERVAL);
	});
	test('rounds fractional seconds', () => {
		expect(clampStatusInterval(59.6)).toBe(60);
	});
});

describe('isStatusStyle', () => {
	test('accepts the known styles, rejects others', () => {
		expect(isStatusStyle('banner')).toBe(true);
		expect(isStatusStyle('scoreboard')).toBe(true);
		expect(isStatusStyle('fancy')).toBe(false);
		expect(isStatusStyle(3)).toBe(false);
	});
});
