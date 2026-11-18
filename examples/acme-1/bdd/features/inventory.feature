Feature: Inventory availability

  @AC1
  Scenario: A stocked item is available on screen
    Given the shopper opens the inventory page
    Then the page shows the heading "Available"
