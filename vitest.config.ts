import { defineConfig } from 'vitest/config'

/**
 * dsh-agent-bus 的 vitest 配置。
 *
 * 需要此文件的原因：vitest 从 cwd 向上查找配置，仓库根的
 * vitest.config.ts 的 `include` 只覆盖 packages 下各包的 tests 目录，
 * 不匹配 dsh-agent-bus/tests —— 不写本地配置则 `pnpm test` 会继承根配置
 * 并报 "No test files found" 退出 1。本地配置显式钉住 include 集合，
 * 同时终止向上的配置搜索。vitest 4 默认 glob 本身已能匹配
 * tests 下的 spec 文件，这里显式写出是为了不被根配置影响，
 * 而非改变默认匹配行为。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
