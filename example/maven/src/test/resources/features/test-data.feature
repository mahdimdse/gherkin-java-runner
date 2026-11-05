Feature: Basket with test data from YAML
  Quoted values in these steps are keys in src/test/resources/testdata/basket.yml.
  The step definitions look them up and log the value with scenario.log(),
  so the Test Results panel shows the value that was actually used.

  Background:
    Given an empty basket

  Scenario: Add fruit using values from the test data
    When I add "apples" apples
    And I add "bananas" bananas
    Then the basket contains "total" items
