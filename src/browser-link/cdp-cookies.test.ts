// The user's cookies in the network messages of the debugger
// (cdp-cookies.ts): what is taken out before a message leaves the browser.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withoutCookies } from './cdp-cookies.ts';

const SECRET = 'sid-value-0123456789';
const cookie = { name: 'sid', value: SECRET, domain: 'example.com', path: '/', httpOnly: true };

describe('a network message of the debugger', () => {
  test('loses the cookie headers of a request and of a response, in every form it carries them', () => {
    const messages: [string, unknown][] = [
      ['Network.requestWillBeSent', { requestId: '1', request: { url: 'https://example.com/', headers: { Accept: '*/*', Cookie: `sid=${SECRET}` } } }],
      ['Network.requestWillBeSent', { requestId: '1', redirectResponse: { headers: { 'set-cookie': `sid=${SECRET}; HttpOnly`, Location: '/next' } } }],
      ['Network.requestWillBeSentExtraInfo', { requestId: '1', associatedCookies: [{ cookie, blockedReasons: [] }], headers: { cookie: `sid=${SECRET}; theme=dark`, accept: '*/*' } }],
      [
        'Network.responseReceivedExtraInfo',
        {
          requestId: '1',
          blockedCookies: [{ blockedReasons: ['SameSiteLax'], cookieLine: `sid=${SECRET}; SameSite=Lax`, cookie }],
          exemptedCookies: [{ exemptionReason: 'UserSetting', cookieLine: `sid=${SECRET}`, cookie }],
          headers: { 'Set-Cookie': `sid=${SECRET}; HttpOnly\nother=${SECRET}`, 'content-type': 'text/html' },
          headersText: `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nSet-Cookie: sid=${SECRET}; HttpOnly\r\nset-cookie: other=${SECRET}\r\n\r\n`,
        },
      ],
      [
        'Network.responseReceived',
        {
          requestId: '1',
          response: {
            url: 'https://example.com/',
            headers: { 'set-cookie': `sid=${SECRET}` },
            requestHeaders: { Cookie: `sid=${SECRET}` },
            requestHeadersText: `GET / HTTP/1.1\r\nHost: example.com\r\nCookie: sid=${SECRET}\r\n\r\n`,
          },
        },
      ],
      ['Network.webSocketWillSendHandshakeRequest', { requestId: '2', request: { headers: { Cookie: `sid=${SECRET}`, Upgrade: 'websocket' } } }],
      [
        'Fetch.requestPaused',
        {
          requestId: '3',
          request: { url: 'https://example.com/', headers: { Cookie: `sid=${SECRET}` } },
          responseHeaders: [
            { name: 'Set-Cookie', value: `sid=${SECRET}` },
            { name: 'Content-Type', value: 'text/html' },
          ],
        },
      ],
    ];

    for (const [method, params] of messages) {
      const text = JSON.stringify(withoutCookies(method, params));

      assert.equal(text.includes(SECRET), false, `${method}: ${text}`);
    }
  });

  test('keeps everything else: the other headers, the names of the cookies, the shape of the message', () => {
    assert.deepEqual(
      withoutCookies('Network.requestWillBeSentExtraInfo', {
        requestId: '1',
        associatedCookies: [{ cookie, blockedReasons: [] }],
        headers: { cookie: `sid=${SECRET}`, accept: '*/*' },
        connectTiming: { requestTime: 1.5 },
      }),
      {
        requestId: '1',
        associatedCookies: [{ cookie: { ...cookie, value: '' }, blockedReasons: [] }],
        headers: { accept: '*/*' },
        connectTiming: { requestTime: 1.5 },
      },
    );
    assert.deepEqual(
      withoutCookies('Network.responseReceivedExtraInfo', { headersText: 'HTTP/1.1 200 OK\r\nSet-Cookie: a=b\r\nContent-Type: text/html\r\n\r\n', statusCode: 200 }),
      { headersText: 'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n', statusCode: 200 },
    );
    assert.deepEqual(withoutCookies('Fetch.requestPaused', { responseHeaders: [{ name: 'set-cookie', value: 'a=b' }, { name: 'X-Cookie-Policy', value: 'strict' }] }), {
      responseHeaders: [{ name: 'X-Cookie-Policy', value: 'strict' }],
    });
  });

  test('of another domain passes as it is, the very object', () => {
    const params = { result: { type: 'string', value: `document.cookie is the page's own: sid=${SECRET}` }, headers: { cookie: 'kept' } };

    assert.equal(withoutCookies('Runtime.evaluate', params), params);
    assert.equal(withoutCookies('Page.frameNavigated', undefined), undefined);
    assert.equal(withoutCookies('Network.loadingFinished', undefined), undefined);
  });
});
