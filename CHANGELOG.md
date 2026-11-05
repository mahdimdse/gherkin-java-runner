# Changelog

## 0.1.1

- Test Results output now lists `@Before` / `@After` hooks next to the steps (`@BeforeStep` / `@AfterStep` when they fail).
- Fixed: `cucumber.plugin=progress` (or another console formatter) in `junit-platform.properties` made runs fail with "Only one plugin can use STDOUT".
- Fixed: failures from newer Cucumber versions showed only the short message, without the exception type and stack trace or the links to step definition lines.

## 0.1.0

- Test Explorer integration for Cucumber features, rules, scenarios, outlines, Examples blocks and rows.
- Maven (incl. multi-module reactors and `mvnw`) and Gradle (incl. multi-project builds and `gradlew`) support.
- Run / debug single Examples rows.
- Tag-expression runs, tag CodeLens and a global `gherkinRunner.tags` filter.
- Debug mode via JDWP + Debugger for Java.
- Ctrl+click / F12 / hover from steps to Java & Kotlin step definitions; undefined-step warnings.
