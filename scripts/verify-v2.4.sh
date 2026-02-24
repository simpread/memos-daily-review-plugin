#!/bin/bash
# v2.4 改进验证脚本

echo "=========================================="
echo "Memos Daily Review Plugin v2.4 验证"
echo "=========================================="
echo ""

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 计数器
PASS=0
FAIL=0

# 验证函数
check() {
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC} $1"
        ((PASS++))
    else
        echo -e "${RED}✗${NC} $1"
        ((FAIL++))
    fi
}

# 1. 文件存在性检查
echo "1. 文件存在性检查"
echo "-------------------"

[ -f "CHANGELOG.md" ]
check "CHANGELOG.md 存在"

[ -f "memos-daily-review-plugin.js" ]
check "主插件文件存在"

[ -f "tests/v2.4-improvements.test.js" ]
check "v2.4 测试文件存在"

[ -f "docs/v2.4-features.md" ]
check "v2.4 功能文档存在"

echo ""

# 2. CHANGELOG.md 内容检查
echo "2. CHANGELOG.md 内容检查"
echo "------------------------"

grep -q "## \[2.4.0\]" CHANGELOG.md
check "包含 v2.4.0 版本"

grep -q "localStorage quota monitoring" CHANGELOG.md
check "记录配额监控功能"

grep -q "markdownToHtml" CHANGELOG.md
check "记录 markdown 重构"

grep -q "Keep a Changelog" CHANGELOG.md
check "符合 Keep a Changelog 格式"

echo ""

# 3. 代码功能检查
echo "3. 代码功能检查"
echo "---------------"

grep -q "calculateStorageStats()" memos-daily-review-plugin.js
check "包含 calculateStorageStats 方法"

grep -q "getStorageReport()" memos-daily-review-plugin.js
check "包含 getStorageReport 方法"

grep -q "logStorageReport()" memos-daily-review-plugin.js
check "包含 logStorageReport 方法"

grep -q "IndentDepthCalculator" memos-daily-review-plugin.js
check "包含 IndentDepthCalculator 模块"

grep -q "ListLevelManager" memos-daily-review-plugin.js
check "包含 ListLevelManager 模块"

grep -q "storageUtils" memos-daily-review-plugin.js
check "测试钩子包含 storageUtils"

echo ""

# 4. 文档链接检查
echo "4. 文档链接检查"
echo "---------------"

grep -q "CHANGELOG.md" README.md
check "README.md 包含 CHANGELOG 链接"

grep -q "更新日志" docs/zh-CN/README.zh-CN.md
check "中文 README 包含更新日志链接"

grep -q "CHANGELOG.md" CLAUDE.md
check "CLAUDE.md 提及 CHANGELOG"

echo ""

# 5. 语法检查
echo "5. 语法检查"
echo "-----------"

node --check memos-daily-review-plugin.js 2>/dev/null
check "JavaScript 语法正确"

echo ""

# 6. 测试执行
echo "6. 测试执行"
echo "-----------"

# v2.4 测试
node --test tests/v2.4-improvements.test.js 2>&1 | grep -q "pass 17"
check "v2.4 测试全部通过 (17/17)"

# 回归测试
node --test tests/algorithm.test.js 2>&1 | grep -q "pass 6"
check "回归测试全部通过 (6/6)"

echo ""

# 7. 代码统计
echo "7. 代码统计"
echo "-----------"

LINES=$(wc -l < memos-daily-review-plugin.js)
echo "主文件行数: $LINES"

if [ $LINES -ge 4900 ] && [ $LINES -le 5000 ]; then
    echo -e "${GREEN}✓${NC} 行数在预期范围内 (4900-5000)"
    ((PASS++))
else
    echo -e "${YELLOW}⚠${NC} 行数超出预期范围: $LINES"
fi

echo ""

# 8. 文档完整性检查
echo "8. 文档完整性检查"
echo "-----------------"

grep -q "Storage Monitoring (v2.4)" CLAUDE.md
check "CLAUDE.md 包含存储监控说明"

grep -q "Refactoring (v2.4)" CLAUDE.md
check "CLAUDE.md 包含 markdown 重构说明"

grep -q "Storage Quota Monitoring (v2.4)" CONTRIBUTING.md
check "CONTRIBUTING.md 包含优化说明"

grep -q "localStorage 配额监控 (v2.4)" docs/zh-CN/CONTRIBUTING.zh-CN.md
check "中文 CONTRIBUTING 包含优化说明"

echo ""

# 9. 总结
echo "=========================================="
echo "验证总结"
echo "=========================================="
echo -e "通过: ${GREEN}${PASS}${NC}"
echo -e "失败: ${RED}${FAIL}${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}✓ 所有验证通过！v2.4 改进实施成功。${NC}"
    exit 0
else
    echo -e "${RED}✗ 发现 $FAIL 个问题，请检查。${NC}"
    exit 1
fi
