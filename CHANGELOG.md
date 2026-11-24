# Changelog

## 0.3.0 (2026-11-24)

- Removed the `lowest` field from the `PublicPrice` type. Code that reads `price.lowest` will no longer compile. To find the cheapest option, compare the prices yourself.

## 0.2.0 (2026-11-16)

- Removed the `description` field from the `ModelParameter` type. Code that reads `description` on the parameters returned by `models.list()` will no longer type-check.
- Documented that `options` in a generation request only accepts the names listed in the model's `parameters`. Any other name fails with `OPTION_UNKNOWN`.
