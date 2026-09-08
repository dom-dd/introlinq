#!/usr/bin/env node
/*
 * build.mjs - injects shared partials into the static HTML pages.
 *
 * Run `node build.mjs` after editing partials/footer.html, then commit the
 * result - the injected output is committed, so there is no Vercel build
 * step (this project deploys the repo as-is). Idempotent: it rewrites the
 * content between the marker comments every time.
 *
 * Right now it handles one partial: the site footer. Each participating page
 * must contain exactly one marker pair:
 *
 *     <!--footer:start-->  ...anything...  <!--footer:end-->
 *
 * Everything between the markers is replaced with partials/footer.html.
 * A page listed here without the markers is a hard error - that's how we
 * catch a page that silently lost its footer.
 *
 * api/blog.js reads partials/footer.html directly at request time, so the
 * /blog and post pages are covered without going through this script.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

const FOOTER = readFileSync(join(ROOT, 'partials/footer.html'), 'utf8').trim();

// Pages that carry the shared footer. Keep this list explicit rather than
// globbing - embed fragments (expertboard, experts, demo/*) and the
// logged-in dashboard deliberately have no footer.
const PAGES = [
  'index.html',
  'privacy.html',
  'terms.html',
  'cookies.html',
  'product/index.html',
  'product/inline-widget.html',
  'product/carousel.html',
  'product/expert-board.html',
  'product/manual-links.html',
  'monetize-finance-blog.html',
  'monetize-health-blog.html',
  'monetize-career-blog.html',
  'monetize-fashion-blog.html',
  'monetize-food-blog.html',
  'monetize-sport-blog.html',
  'monetize-beauty-blog.html',
  'monetize-parenting-blog.html',
  'signup/index.html',
  'login/index.html',
];

const START = '<!--footer:start-->';
const END = '<!--footer:end-->';
// Greedy on purpose: spans from the first start marker to the last end
// marker, so a page that somehow ended up with a nested/duplicated pair
// collapses back to a single clean block on the next run.
const BLOCK_RE = /<!--footer:start-->[\s\S]*<!--footer:end-->/;

let changed = 0;
const problems = [];

for (const rel of PAGES) {
  const path = join(ROOT, rel);
  let html;
  try {
    html = readFileSync(path, 'utf8');
  } catch {
    problems.push(`${rel}: file not found`);
    continue;
  }

  const firstStart = html.indexOf(START);
  const lastEnd = html.lastIndexOf(END);
  if (firstStart === -1 || lastEnd === -1 || lastEnd < firstStart) {
    problems.push(`${rel}: missing a ${START} ... ${END} marker pair`);
    continue;
  }

  const next = html.replace(BLOCK_RE, `${START}\n${FOOTER}\n${END}`);
  if (next !== html) {
    writeFileSync(path, next);
    changed++;
    console.log(`  footer -> ${rel}`);
  }
}

if (problems.length) {
  console.error('\nbuild.mjs: footer injection failed:\n  ' + problems.join('\n  '));
  process.exit(1);
}

console.log(`build.mjs: footer up to date on ${PAGES.length} pages (${changed} rewritten).`);
