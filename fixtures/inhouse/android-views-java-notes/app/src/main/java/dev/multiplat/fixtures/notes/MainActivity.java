package dev.multiplat.fixtures.notes;

import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.TextView;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;
import java.util.ArrayList;
import java.util.List;

/** The list screen: search, add, open a note. Deleting happens in the editor. */
public final class MainActivity extends AppCompatActivity {
    private NoteStore store;
    private NotesAdapter adapter;
    private EditText search;
    private TextView empty;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        search = findViewById(R.id.search_notes);
        empty = findViewById(R.id.empty_state);
        RecyclerView list = findViewById(R.id.notes_list);
        list.setLayoutManager(new LinearLayoutManager(this));
        adapter = new NotesAdapter(note -> startActivity(NoteEditorActivity.intent(this, note.id)));
        list.setAdapter(adapter);
        findViewById(R.id.add_note).setOnClickListener(v -> startActivity(NoteEditorActivity.intent(this, null)));
        search.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {}

            @Override
            public void afterTextChanged(Editable s) {
                reload();
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        // The editor writes through its own store; re-read so its changes show up.
        store = new NoteStore(new PrefsStorage(this));
        reload();
    }

    private void reload() {
        if (store == null) return;
        List<Note> shown = store.filtered(search.getText().toString());
        empty.setVisibility(shown.isEmpty() ? View.VISIBLE : View.GONE);
        adapter.submit(shown);
    }

    static final class NotesAdapter extends RecyclerView.Adapter<NotesAdapter.Holder> {
        interface OnOpen {
            void open(Note note);
        }

        private final OnOpen onOpen;
        private List<Note> items = new ArrayList<>();

        NotesAdapter(OnOpen onOpen) {
            this.onOpen = onOpen;
        }

        void submit(List<Note> notes) {
            items = notes;
            notifyDataSetChanged();
        }

        @NonNull
        @Override
        public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
            View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_note, parent, false);
            return new Holder(view);
        }

        @Override
        public void onBindViewHolder(@NonNull Holder holder, int position) {
            Note note = items.get(position);
            holder.title.setText(note.title);
            holder.excerpt.setText(NoteStore.excerpt(note.body, 60));
            holder.itemView.setOnClickListener(v -> onOpen.open(note));
        }

        @Override
        public int getItemCount() {
            return items.size();
        }

        static final class Holder extends RecyclerView.ViewHolder {
            final TextView title;
            final TextView excerpt;

            Holder(View view) {
                super(view);
                title = view.findViewById(R.id.note_title);
                excerpt = view.findViewById(R.id.note_excerpt);
            }
        }
    }
}
