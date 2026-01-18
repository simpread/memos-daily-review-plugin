# Memos Daily Review Plugin

English | [中文](./README.md)

> Memos 每日回顾插件 / Memos Daily Review Plugin
> A "Daily Review" frontend plugin for [usememos/memos](https://github.com/usememos/memos).

Revisit past memos in a card-by-card browsing experience, helping with review and sparking new connections between ideas.
<img width="3810" height="1890" alt="11" src="https://github.com/user-attachments/assets/83d393af-1c32-43e8-9694-c6234316574b" />

## Features

- Card-by-card browsing with prev/next navigation
- Daily fixed deck, same content throughout the day
- Shuffle to regenerate deck locally without server requests
- Review preference, avoids recent repeats, prioritizes long-unseen content
- Spark pairing, intelligently inserts memo pairs sharing the same tag but far apart in time
- Image popup preview with multi-image navigation
- Markdown rendering, supports headings, lists (nested), inline formatting
- Edit and sync, edit current memo and save to server

## Installation

1. Open Memos: **Settings → System → Additional Script**
2. Copy the entire content of `memos-daily-review-plugin.js` and paste it
3. Save and refresh the page
4. Click the "每日回顾" (Daily Review) button in the bottom-right corner

> This is a community plugin, not an official Memos feature. You can remove it anytime if issues occur.

## Configuration

Adjust settings in the plugin's "回顾设置" (Review Settings) tab:

| Option | Values | Default |
|--------|--------|---------|
| Time Range | All / 1 Year / 6 Months / 3 Months / 1 Month | 6 Months |
| Daily Count | 4 / 8 / 12 / 16 / 20 / 24 | 8 |

For advanced parameters, edit the `CONFIG` object at the top of the js file.

## Compatibility

- Works with Memos versions supporting API v1
- Not logged in: can only fetch public memos
- Edit feature requires login and permissions

## FAQ

**Empty when opened?** Not logged in or time range too narrow.
**Edit save failed?** Not logged in or no edit permission.
**Button not visible?** The plugin auto-hides on the login page.

## Disclaimer

This project was initiated by a hobbyist. The author has no coding background — **the entire development was completed with AI assistance**.

Due to limited expertise, the author may not be able to resolve all issues. Issues, Forks, and Pull Requests are welcome!

## Technical Documentation

See [CONTRIBUTING.en.md](./CONTRIBUTING.en.md) for development guide.

