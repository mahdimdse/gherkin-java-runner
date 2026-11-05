package com.example.data;

import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.Map;

/** Test data loaded from a YAML file on the test classpath. Nested keys use dots: "basket.total". */
public final class GivenData {
    private final Map<String, Object> values;

    private GivenData(Map<String, Object> values) {
        this.values = values;
    }

    public static GivenData load(String resource) {
        try (InputStream in = GivenData.class.getClassLoader().getResourceAsStream(resource)) {
            if (in == null) throw new IllegalArgumentException("Test data not found on the classpath: " + resource);
            Map<String, Object> map = new Yaml().load(in);
            return new GivenData(map == null ? Map.of() : map);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public Object get(String key) {
        Object value = values;
        for (String part : key.split("\\.")) {
            if (!(value instanceof Map<?, ?> map) || !map.containsKey(part)) {
                throw new IllegalArgumentException("No test data for key '" + key + "'");
            }
            value = map.get(part);
        }
        return value;
    }

    public int getInt(String key) {
        Object value = get(key);
        return value instanceof Number n ? n.intValue() : Integer.parseInt(String.valueOf(value).trim());
    }
}
