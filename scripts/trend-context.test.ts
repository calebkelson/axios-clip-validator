import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleNewsRss, topicSearchQuery } from './trend-context.js';
import type { TrendTopic } from './trending.js';

test('parses Google News RSS evidence without requiring an XML package', () => {
  const items = parseGoogleNewsRss(`
    <rss><channel><item>
      <title><![CDATA[OpenAI &amp; security update]]></title>
      <link>https://example.com/story</link>
      <description><![CDATA[Coverage about OpenAI.]]></description>
      <pubDate>Mon, 17 Aug 2026 12:00:00 GMT</pubDate>
      <source>Example News</source>
    </item></channel></rss>
  `);
  assert.deepEqual(items, [{
    title: 'OpenAI & security update',
    description: 'Coverage about OpenAI.',
    url: 'https://example.com/story',
    publishedAt: 'Mon, 17 Aug 2026 12:00:00 GMT',
    source: 'Example News',
  }]);
});

test('builds a focused web context query from the topic keywords', () => {
  const topic = { topic: 'OpenAI', keywords: ['OpenAI', 'AI', 'security'], raw: {} } as TrendTopic;
  assert.equal(topicSearchQuery(topic), 'OpenAI OpenAI AI security');
});
