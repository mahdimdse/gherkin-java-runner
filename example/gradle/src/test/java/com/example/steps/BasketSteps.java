package com.example.steps;

import io.cucumber.java.Before;
import io.cucumber.java.ParameterType;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;

import static org.junit.jupiter.api.Assertions.assertEquals;

public class BasketSteps {
    enum Fruit { APPLE, BANANA, CUCUMBER }

    private int total;

    @Before
    public void reset() {
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
}
