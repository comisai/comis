import { describe, expect, it } from "vitest";
import { normalizeLocation } from "./location-normalizer.js";

describe("location-normalizer", () => {
  describe("normalizeLocation", () => {
    it("returns coordinates and text with name", () => {
      const result = normalizeLocation(40.7128, -74.006, { name: "NYC" });

      expect(result.text).toBe("[Location: NYC]");
      expect(result.location).toEqual({
        latitude: 40.7128,
        longitude: -74.006,
        name: "NYC",
      });
    });

    it("returns coordinates and text with address when no name", () => {
      const result = normalizeLocation(48.8566, 2.3522, { address: "Paris, France" });

      expect(result.text).toBe("[Location: Paris, France]");
      expect(result.location).toEqual({
        latitude: 48.8566,
        longitude: 2.3522,
        address: "Paris, France",
      });
    });

    it("returns coordinates in text when no name or address", () => {
      const result = normalizeLocation(40.712800, -74.006000);

      expect(result.text).toBe("[Location: 40.712800, -74.006000]");
      expect(result.location).toEqual({
        latitude: 40.7128,
        longitude: -74.006,
      });
    });

    it("includes accuracy when provided", () => {
      const result = normalizeLocation(40.7128, -74.006, { accuracy: 10 });

      expect(result.location.accuracy).toBe(10);
    });

    it("omits optional fields when not provided", () => {
      const result = normalizeLocation(0, 0);

      expect(result.location).toEqual({ latitude: 0, longitude: 0 });
      expect(result.location).not.toHaveProperty("accuracy");
      expect(result.location).not.toHaveProperty("name");
      expect(result.location).not.toHaveProperty("address");
    });

    it("includes both name and address when both provided", () => {
      const result = normalizeLocation(48.8566, 2.3522, {
        name: "Eiffel Tower",
        address: "Paris, France",
      });

      // Name takes priority in text label
      expect(result.text).toBe("[Location: Eiffel Tower]");
      expect(result.location.name).toBe("Eiffel Tower");
      expect(result.location.address).toBe("Paris, France");
    });

    it("handles zero accuracy", () => {
      const result = normalizeLocation(0, 0, { accuracy: 0 });

      expect(result.location.accuracy).toBe(0);
    });
  });
});
