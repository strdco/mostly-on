// What the Register dialog says when it cannot connect, from the errors the
// driver really throws (shapes as seen against SQL Server 2025 on Linux).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectErrorText } from '../../src/sql/pool.js';

const s = { host: 'sql3', port: 1433, username: 'mostly_on' };
const driverError = (code, message, cause) => Object.assign(new Error(message), { name: 'ConnectionError', code, originalError: Object.assign(new Error(message), { code, cause }) });
const sys = (code) => Object.assign(new Error(code), { code });

test('a host name that does not exist', () => {
    const err = driverError('ESOCKET', 'Failed to connect to sql33:1433 - getaddrinfo ENOTFOUND sql33', sys('ENOTFOUND'));
    assert.match(connectErrorText({ ...s, host: 'sql33' }, err), /could not find a computer called sql33\. Check the host name\. If the name works elsewhere, try its full name/);
    assert.doesNotMatch(connectErrorText({ ...s, host: 'sql33.example.com' }, err), /full name/, 'already a full name');
});

test('nothing listening on the port (the cause is an AggregateError, one per address)', () => {
    const err = driverError('ESOCKET', 'Failed to connect to localhost:1 - Could not connect (sequence)', new AggregateError([sys('ECONNREFUSED'), sys('ECONNREFUSED')], 'Could not connect (sequence)'));
    assert.match(connectErrorText({ ...s, port: 1 }, err), /^sql3 refused the connection: nothing accepts connections on port 1 there/);
    assert.match(connectErrorText({ ...s, host: 'localhost' }, err), /localhost is the Mostly-On container itself/);
});

test('the login is turned down', () => {
    const err = driverError('ELOGIN', "Login failed for user 'mostly_on'.");
    assert.match(connectErrorText(s, err), /sql3:1433 turned down the login mostly_on\. Either the login does not exist there yet .* error log on sql3 says which/);
    const expired = driverError('ELOGIN', "Login failed for user 'mostly_on'. Reason: The password of the account has expired.");
    assert.match(connectErrorText(s, expired), /turned down the login mostly_on: Login failed .* has expired\.$/, 'a reason SQL Server gives is passed on');
});

test('an untrusted certificate, a timeout, and anything else', () => {
    const cert = driverError('ESOCKET', 'Failed to connect to sql3:1433 - self-signed certificate', sys('DEPTH_ZERO_SELF_SIGNED_CERT'));
    assert.match(connectErrorText(s, cert), /does not trust \(self-signed certificate\)\. Tick Trust server certificate/);
    const slow = driverError('ETIMEOUT', 'Failed to connect to 10.255.255.1:1433 in 10000ms');
    assert.match(connectErrorText(s, slow), /^No answer from sql3:1433 within 10 seconds\. Check the host name and port/);
    assert.match(connectErrorText({ ...s, instance_name: 'SQLEXPRESS' }, slow), /^No answer from sql3\\SQLEXPRESS .* SQL Server Browser service/);
    assert.equal(connectErrorText(s, driverError('EOTHER', 'Something new')), 'Mostly-On could not connect to sql3:1433: Something new');
});
