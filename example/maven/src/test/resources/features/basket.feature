@basket
Feature: Basket

  Background:
    Given an empty basket

  @smoke
  Scenario: Add one fruit
    When I add 1 apple
    Then the basket contains 1 item

  Scenario Outline: Add several fruits
    When I add <count> <fruit>s
    Then the basket contains <total> items

    @fast
    Examples: small
      | count | fruit    | total |
      | 2     | banana   | 2     |
      | 3     | cucumber | 3     |

    @wip
    Examples: broken on purpose
      | count | fruit | total |
      | 5     | apple | 4     |
