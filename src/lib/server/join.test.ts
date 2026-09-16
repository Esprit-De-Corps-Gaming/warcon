import { describe, expect, test } from 'bun:test';
import { steamJoinLinks, validateJoinAddress } from './join';

describe('validateJoinAddress', () => {
	test('ip and hostname with a port', () => {
		expect(validateJoinAddress('165.217.128.166:9025')).toBe('165.217.128.166:9025');
		expect(validateJoinAddress(' Play.Example.ORG:7777 ')).toBe('play.example.org:7777');
	});
	test('blank clears', () => {
		expect(validateJoinAddress('')).toBe('');
		expect(validateJoinAddress(undefined)).toBe('');
	});
	test('refuses missing or bad ports and hosts', () => {
		for (const bad of [
			'165.217.128.166',
			'165.217.128.166:0',
			'host:70000',
			'steam://x:1',
			'a b:1'
		])
			expect(() => validateJoinAddress(bad)).toThrow('host:port');
	});
});

describe('steamJoinLinks', () => {
	test('the three variants', () => {
		expect(steamJoinLinks('165.217.128.166:9025')).toEqual({
			connect: 'steam://connect/165.217.128.166:9025',
			run: 'steam://run/1867240//+connect%20165.217.128.166%3A9025/',
			launch: 'steam://rungameid/1867240'
		});
	});
});
