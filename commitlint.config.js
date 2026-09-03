export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "build",
        "patch",
        "fix",
        "docs",
        "perf",
        "refactor",
        "revert",
        "style",
        "test",
        "ci",
        "chore",
        "ignore"
      ]
    ]
  }
};
