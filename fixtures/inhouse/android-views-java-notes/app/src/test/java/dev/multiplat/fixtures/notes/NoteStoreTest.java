package dev.multiplat.fixtures.notes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class NoteStoreTest {
    private static final class MemoryStorage implements NoteStore.Storage {
        final Map<String, String> map = new HashMap<>();

        @Override
        public String read(String key) {
            return map.get(key);
        }

        @Override
        public void write(String key, String value) {
            map.put(key, value);
        }
    }

    private static List<String> titles(List<Note> notes) {
        List<String> out = new ArrayList<>();
        for (Note n : notes) out.add(n.title);
        return out;
    }

    @Test
    public void addPutsNewestFirstAndPersists() {
        MemoryStorage storage = new MemoryStorage();
        NoteStore store = new NoteStore(storage);
        store.add("First", "a", 1000);
        store.add("Second", "b", 2000);
        assertEquals(Arrays.asList("Second", "First"), titles(store.notes()));
        assertEquals(store.notes(), new NoteStore(storage).notes());
    }

    @Test
    public void titleFallsBackToFirstBodyLine() {
        assertEquals("Buy milk", NoteStore.normalizedTitle("  ", "Buy milk\nand eggs"));
        assertEquals("Untitled", NoteStore.normalizedTitle("", ""));
        assertEquals(80, NoteStore.normalizedTitle("x".repeat(100), "").length());
    }

    @Test
    public void searchIsCaseInsensitiveOnTitleAndBody() {
        NoteStore store = new NoteStore(new MemoryStorage());
        store.add("Groceries", "Milk and eggs", 1);
        store.add("Ideas", "A note app", 2);
        assertEquals(Arrays.asList("Groceries"), titles(store.filtered("MILK")));
        assertEquals(Arrays.asList("Ideas"), titles(store.filtered("note")));
        assertEquals(2, store.filtered("  ").size());
    }

    @Test
    public void excerptCollapsesWhitespaceAndCuts() {
        assertEquals("a b c", NoteStore.excerpt("a  b\n\nc", 60));
        assertEquals("word word…", NoteStore.excerpt("word word word word", 10));
    }

    @Test
    public void deleteRemovesAndPersists() {
        MemoryStorage storage = new MemoryStorage();
        NoteStore store = new NoteStore(storage);
        Note note = store.add("Gone", "", 1);
        store.delete(note.id);
        assertTrue(store.isEmpty());
        assertTrue(new NoteStore(storage).isEmpty());
    }
}
