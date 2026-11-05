# Gherkin Runner for Java

Run and debug Cucumber scenarios for Java straight from VS Code's **Test Explorer** — for **Maven and Gradle** projects.

## Features

- **Test Explorer tree**: feature → rule → scenario / outline → Examples block → **individual Examples rows**. Gutter ▶ icons appear on every scenario and row.
- **Run a single Examples row**: each row is its own test. Run it, debug it, or see its result on its own.
- **Tag filtering**, three ways:
  - **Cucumber: Run/Debug Scenarios by Tag Expression…** (Command Palette or the editor's run menu), e.g. `@smoke and not @wip`.
  - **Run with Tag Expression…** / **Debug with Tag Expression…** profiles in the Test Explorer run drop-down, which filter whatever you selected.
  - **`▷ @tag` CodeLens** above every tag line runs all scenarios with that tag.
  - Every test item is tagged, so the Test Explorer filter box works too: `@gherkinRunner:smoke`.
  - Set `gherkinRunner.tags` (e.g. `not @wip`) to apply a filter to every run.
- **Debug mode**: starts the test JVM with JDWP, waits for it to listen, and attaches the Java debugger. Breakpoints in step definitions just work. Stopping the debugger stops the test JVM.
- **Ctrl+click (Cmd+click) a step** to jump to its Java step definition. F12 and Peek Definition work too, and hovering a step shows which method it binds to. Supported:
  - Cucumber Expressions, including optional text, alternatives and custom `@ParameterType`s.
  - Regular expressions.
  - Scenario Outline steps with `<placeholders>`.
  - Localized keywords (`# language: de` with `@Angenommen`).
  - cucumber-java8 lambdas and Kotlin.
- **Undefined-step warnings** in the editor.
- **Rich results**:
  - Failures point at the failing step line.
  - Assertion messages show an expected/actual diff.
  - Stack frames link to your step code.
  - Undefined steps include Cucumber's suggested snippet.

## Requirements

| What | Why |
|---|---|
| JDK 8+ (JDK 9+ recommended) | runs Cucumber |
| Maven 3.6.1+ or Gradle 6+ (`mvnw` / `gradlew` wrappers are used automatically) | compiles tests and resolves the test classpath |
| `io.cucumber:cucumber-java` as a test dependency | provides `io.cucumber.core.cli.Main` |
| [Debugger for Java](https://marketplace.visualstudio.com/items?itemName=vscjava.vscode-java-debug) + [Language Support for Java](https://marketplace.visualstudio.com/items?itemName=redhat.java) | debug mode only |

A JUnit runner class is **not** required.

## Usage

1. Open a folder that contains `.feature` files. They appear in the **Testing** view.
2. Click ▶ (run) or the bug icon (debug) on a feature, scenario, Examples block or row.
3. To debug, set a breakpoint in a step definition first, then choose **Debug**.
4. Ctrl+click any step to open its definition.

Try it on the projects in `example/maven` and `example/gradle`.

## How it works

1. **Discovery**: feature files are parsed with the official `@cucumber/gherkin` parser.
2. **Compile + classpath**:
   - Maven runs `test-compile dependency:build-classpath`. In multi-module reactors it uses `-pl <module> -am` from the root.
   - Gradle runs `testClasses` plus a tiny init script that writes `sourceSets.test.runtimeClasspath`. Your build files are not changed.
3. **Run**: the extension launches `java io.cucumber.core.cli.Main` with the selected `file.feature:line:line` arguments. It uses an `@argfile`, so long classpaths work on Windows.
4. **Glue**: the first of these that applies is used:
   - the `gherkinRunner.glue` setting
   - `cucumber.glue` in `junit-platform.properties` / `cucumber.properties`
   - glue declared on your runner class (`@ConfigurationParameter(key = GLUE_PROPERTY_NAME, …)` or `@CucumberOptions(glue = …)`)
   - auto-detected packages of classes that use Cucumber annotations
5. **Other properties**: remaining `cucumber.*` keys from those files, such as `cucumber.object-factory` for Spring, are passed as system properties.
6. **Results**: Cucumber's `message` (NDJSON) output is read as it is written and mapped back to scenarios and rows by line number.
7. **Debug**: `-agentlib:jdwp=…,suspend=y` on a free port, then a `java` attach configuration.

## Settings

| Setting | Default | Description |
|---|---|---|
| `gherkinRunner.buildTool` | `auto` | `auto`, `maven` or `gradle` |
| `gherkinRunner.mavenExecutable` / `gradleExecutable` | wrapper, else PATH | Override the build command |
| `gherkinRunner.mavenArgs` / `gradleArgs` | `[]` | Extra build args, e.g. `["-o"]`, `["-Pit"]` |
| `gherkinRunner.compileBeforeRun` | `true` | Turn off to reuse the last classpath (faster, no recompile) |
| `gherkinRunner.javaHome` | | JDK to run tests. Fallback order: `JAVA_HOME` → `java.jdt.ls.java.home` → PATH |
| `gherkinRunner.glue` | `[]` | Glue packages (see above) |
| `gherkinRunner.vmArgs` | `[]` | e.g. `["-Dspring.profiles.active=test"]` |
| `gherkinRunner.env` | `{}` | Environment variables for the test JVM |
| `gherkinRunner.cucumberArgs` | `[]` | e.g. `["--plugin", "html:target/cucumber.html"]` |
| `gherkinRunner.prettyOutput` | `true` | Step-by-step console output in Test Results |
| `gherkinRunner.tags` | | Tag expression applied to every run |
| `gherkinRunner.featureGlob` | `**/*.feature` | Where to find features |
| `gherkinRunner.stepDefinitionGlob` | `**/*.{java,kt}` | Where to find step definitions |
| `gherkinRunner.exclude` | build/output folders | Ignored folders |
| `gherkinRunner.diagnostics.undefinedSteps` | `true` | Warn on unmatched steps |
| `gherkinRunner.codeLens.tags` | `true` | `▷ @tag` CodeLens |
| `gherkinRunner.debug.attachTimeout` | `120` | Seconds to wait for the debug port |

## Build from source

```bash
npm install
npm test            # unit tests
npm run test:e2e    # drives the runner with fake mvn/java (macOS/Linux)
npm run package     # produces gherkin-java-runner-<version>.vsix
code --install-extension gherkin-java-runner-0.1.0.vsix
```

Press **F5** with `.vscode/launch.json` to run the extension in an Extension Development Host.

Before publishing, change `publisher` and `repository` in `package.json`.

## Known limitations

- **Maven output folders**: Maven classpaths assume the default `target/classes` and `target/test-classes`.
- **Kotlin**: navigation works for annotation-style Kotlin steps. Kotlin raw-string (`"""`) expressions are not indexed.
- **Unsaved edits**: the extension saves all files before each run. If a run reports "did not run", the line numbers changed while it was starting.
