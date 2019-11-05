import { Map, List, fromJS } from 'immutable';
import {
  DRAFT_CREATE_FROM_ENTRY,
  DRAFT_CREATE_EMPTY,
  DRAFT_DISCARD,
  DRAFT_CHANGE_FIELD,
  DRAFT_VALIDATION_ERRORS,
  DRAFT_CLEAR_ERRORS,
  DRAFT_LOCAL_BACKUP_RETRIEVED,
  DRAFT_CREATE_FROM_LOCAL_BACKUP,
  ENTRY_PERSIST_REQUEST,
  ENTRY_PERSIST_SUCCESS,
  ENTRY_PERSIST_FAILURE,
  ENTRY_DELETE_SUCCESS,
  ADD_DRAFT_ENTRY_MEDIA_FILE,
  ADD_DRAFT_ENTRY_MEDIA_FILES,
  REMOVE_DRAFT_ENTRY_MEDIA_FILE,
} from 'Actions/entries';
import {
  UNPUBLISHED_ENTRY_PERSIST_REQUEST,
  UNPUBLISHED_ENTRY_PERSIST_SUCCESS,
  UNPUBLISHED_ENTRY_PERSIST_FAILURE,
} from 'Actions/editorialWorkflow';

const initialState = Map({
  entry: Map(),
  mediaFiles: List(),
  fieldsMetaData: Map(),
  fieldsErrors: Map(),
  hasChanged: false,
});

const entryDraftReducer = (state = Map(), action) => {
  switch (action.type) {
    case DRAFT_CREATE_FROM_ENTRY:
      // Existing Entry
      return state.withMutations(state => {
        state.set('entry', action.payload.entry);
        state.setIn(['entry', 'newRecord'], false);
        state.set('mediaFiles', action.payload.mediaFiles || List());
        // An existing entry may already have metadata. If we surfed away and back to its
        // editor page, the metadata will have been fetched already, so we shouldn't
        // clear it as to not break relation lists.
        state.set('fieldsMetaData', action.payload.metadata || Map());
        state.set('fieldsErrors', Map());
        state.set('hasChanged', false);
      });
    case DRAFT_CREATE_EMPTY:
      // New Entry
      return state.withMutations(state => {
        state.set('entry', fromJS(action.payload));
        state.setIn(['entry', 'newRecord'], true);
        state.set('mediaFiles', List());
        state.set('fieldsMetaData', Map());
        state.set('fieldsErrors', Map());
        state.set('hasChanged', false);
      });
    case DRAFT_CREATE_FROM_LOCAL_BACKUP:
      // Local Backup
      return state.withMutations(state => {
        const backupDraftEntry = state.get('localBackup');
        const backupEntry = backupDraftEntry.get('entry');
        state.delete('localBackup');
        state.set('entry', backupEntry);
        state.setIn(['entry', 'newRecord'], !backupEntry.get('path'));
        state.set('mediaFiles', backupDraftEntry.get('mediaFiles'));
        state.set('fieldsMetaData', Map());
        state.set('fieldsErrors', Map());
        state.set('hasChanged', true);
      });
    case DRAFT_DISCARD:
      return initialState;
    case DRAFT_LOCAL_BACKUP_RETRIEVED:
      return state.set('localBackup', fromJS(action.payload));
    case DRAFT_CHANGE_FIELD:
      return state.withMutations(state => {
        state.setIn(['entry', 'data', action.payload.field], action.payload.value);
        state.mergeDeepIn(['fieldsMetaData'], fromJS(action.payload.metadata));
        state.set('hasChanged', true);
      });

    case DRAFT_VALIDATION_ERRORS:
      if (action.payload.errors.length === 0) {
        return state.deleteIn(['fieldsErrors', action.payload.uniquefieldId]);
      } else {
        return state.setIn(['fieldsErrors', action.payload.uniquefieldId], action.payload.errors);
      }

    case DRAFT_CLEAR_ERRORS: {
      return state.set('fieldsErrors', Map());
    }

    case ENTRY_PERSIST_REQUEST:
    case UNPUBLISHED_ENTRY_PERSIST_REQUEST: {
      return state.setIn(['entry', 'isPersisting'], true);
    }

    case ENTRY_PERSIST_FAILURE:
    case UNPUBLISHED_ENTRY_PERSIST_FAILURE: {
      return state.deleteIn(['entry', 'isPersisting']);
    }

    case ENTRY_PERSIST_SUCCESS:
    case UNPUBLISHED_ENTRY_PERSIST_SUCCESS:
      return state.withMutations(state => {
        state.deleteIn(['entry', 'isPersisting']);
        state.set('hasChanged', false);
        if (!state.getIn(['entry', 'slug'])) {
          state.setIn(['entry', 'slug'], action.payload.slug);
        }
      });

    case ENTRY_DELETE_SUCCESS:
      return state.withMutations(state => {
        state.deleteIn(['entry', 'isPersisting']);
        state.set('hasChanged', false);
      });

    case ADD_DRAFT_ENTRY_MEDIA_FILE:
      if (state.has('mediaFiles')) {
        return state.update('mediaFiles', list =>
          list.filterNot(file => file.id === action.id).push({ ...action.payload }),
        );
      }
      return state;

    case ADD_DRAFT_ENTRY_MEDIA_FILES: {
      let newState = state;
      if (!newState.has('mediaFiles')) {
        newState = newState.set('mediaFiles', List());
      }

      action.payload.forEach(file => {
        newState = newState.update('mediaFiles', list => list.push({ ...file }));
      });

      return newState;
    }

    case REMOVE_DRAFT_ENTRY_MEDIA_FILE:
      if (state.has('mediaFiles')) {
        return state.update('mediaFiles', list =>
          list.filterNot(file => file.id === action.payload.id),
        );
      }
      return state;
    default:
      return state;
  }
};

export default entryDraftReducer;
