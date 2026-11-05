package com.example.steps;

import com.example.data.GivenData;
import io.cucumber.java.Before;
import io.cucumber.java.ParameterType;
import io.cucumber.java.Scenario;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;

import static org.junit.jupiter.api.Assertions.assertEquals;

public class BasketSteps {
    enum Fruit { APPLE, BANANA, CUCUMBER }

    private final GivenData givenData = GivenData.load("testdata/basket.yml");
    private Scenario scenario;
    private int total;

    @Before
    public void reset(Scenario scenario) {
        this.scenario = scenario;
        total = 0;
    }

    @ParameterType("apple|banana|cucumber")
    public Fruit fruit(String name) {
        return Fruit.valueOf(name.toUpperCase());
    }

    @Given("an empty basket")
    public void anEmptyBasket() {
        total = 0;
    }

    @When("I add {int} {fruit}(s)")
    public void iAdd(int count, Fruit fruit) {
        total += count;   // <- put a breakpoint here and use "Debug" in the Test Explorer
    }

    @Then("the basket contains {int} item(s)")
    public void theBasketContains(int expected) {
        assertEquals(expected, total);
    }

    // Steps that take a key from testdata/basket.yml instead of a literal value.

    @When("I add {string} {fruit}(s)")
    public void iAddFromData(String key, Fruit fruit) {
        iAdd(data(key), fruit);
    }

    @Then("the basket contains {string} item(s)")
    public void theBasketContainsFromData(String key) {
        theBasketContains(data(key));
    }

    /** Looks a key up in the test data and logs the value, so Test Results shows what was used. */
    private int data(String key) {
        int value = givenData.getInt(key);
        scenario.log(key + " = " + value);
        return value;
    }
}
