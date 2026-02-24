# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.0] - 2026-02-24

### Added
- localStorage quota monitoring and reporting
  - `calculateStorageStats()` method to track storage usage
  - `getStorageReport()` for human-readable size breakdown
  - Automatic reporting every 10 minutes and after cleanup
  - Storage state logging before quota exceeded cleanup

### Changed
- Refactored `markdownToHtml` function for better maintainability
  - Extracted `IndentDepthCalculator` module (35 lines)
  - Extracted `ListLevelManager` module (45 lines)
  - Reduced main function from 156 to 100 lines
  - Reduced cyclomatic complexity from ~25 to ~12
  - Improved testability and code organization

### Fixed
- Improved error visibility for localStorage quota issues

## [2.3.0] - 2026-02-24

### Added
- Keyboard focus management for improved accessibility
- ARIA labels and roles for screen reader support
- Focus trap and restoration in dialogs
- Comprehensive accessibility tests

### Fixed
- Code review issues related to accessibility implementation
- Focus management edge cases

## [2.2.0] - 2026-02-23

### Added
- Tooltip hints for all icon buttons
- Smooth UI animations (slide, fade-in, fade-out)
- Deletion animations with visual feedback
- Edit dialog animations and loading states
- Image preview with smooth transitions
- Shuffle button animation and deck transitions
- Mobile-responsive optimizations (< 640px)
- Improved empty state design with icon and hint text
- Delayed loading indicator to prevent flicker

### Fixed
- Delete button icon restoration after successful deletion
- Memory leak from event listeners on dialog close
- Code review issues related to UI enhancements

## [2.1.0] - 2026-02-23

### Added
- Comprehensive error handling and retry mechanism
- Memos API compatibility layer with adaptive fallback
- Adaptive pool sizing algorithm
- Time-based bucket system for deck generation
- Diversity-aware sampling with penalty system
- Compatibility regression tests
- Performance benchmarks documentation

### Fixed
- Cached pool reuse logic
- Auth endpoint fallback preservation
- Delete render path issues

### Changed
- Improved deck algorithm with time buckets (newest/middle/oldest)
- Enhanced documentation for compatibility and architecture

## [2.0.0] - 2026-02-05

### Added
- Internationalization (i18n) support with auto-detection
- English and Chinese (Simplified) translations
- Bilingual documentation (English + Chinese)
- Performance optimizations with precompiled regex patterns
- DocumentFragment for batch DOM insertion
- Event delegation for image preview
- CSS transitions instead of JavaScript animations

### Fixed
- Language switch state persistence
- Relative URL handling issues

### Changed
- Major refactoring for i18n architecture
- Updated project structure documentation

## [1.0.0] - 2026-01-18

### Added
- Initial release
- Daily review functionality with deterministic deck generation
- Review priority algorithm with diversity penalty
- Spark pair algorithm for tag-based connections
- Markdown rendering with nested list support
- localStorage caching (pool, deck, history)
- LRU history pruning (max 3000 items)
- Time range filters (all, 1 year, 6 months, 3 months, 1 month)
- Count options (4, 8, 12, 16, 20, 24 cards)
- Edit and delete memo functionality
- Image preview with click-to-enlarge
- Floating button UI with modal dialog
- Theme compatibility using Memos CSS variables
- Mobile-responsive design

[Unreleased]: https://github.com/simpread/memos-daily-review-plugin/compare/v2.4.0...HEAD
[2.4.0]: https://github.com/simpread/memos-daily-review-plugin/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/simpread/memos-daily-review-plugin/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/simpread/memos-daily-review-plugin/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/simpread/memos-daily-review-plugin/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/simpread/memos-daily-review-plugin/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/simpread/memos-daily-review-plugin/releases/tag/v1.0.0
