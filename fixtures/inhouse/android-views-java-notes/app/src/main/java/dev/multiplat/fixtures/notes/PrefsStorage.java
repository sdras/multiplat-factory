package dev.multiplat.fixtures.notes;

import android.content.Context;
import android.content.SharedPreferences;

/** The app's storage: a private SharedPreferences file named {@code notes}. */
public final class PrefsStorage implements NoteStore.Storage {
    private final SharedPreferences prefs;

    public PrefsStorage(Context context) {
        prefs = context.getSharedPreferences("notes", Context.MODE_PRIVATE);
    }

    @Override
    public String read(String key) {
        return prefs.getString(key, null);
    }

    @Override
    public void write(String key, String value) {
        prefs.edit().putString(key, value).apply();
    }
}
