# 3_visualize_atlas.py
import streamlit as st
import pandas as pd
import duckdb
from embedding_atlas.streamlit import embedding_atlas
import requests
import json

st.set_page_config(layout="wide")

# OpenRouter API Configuration
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

# Securely get API key from Streamlit secrets or environment
try:
    OPENROUTER_API_KEY = st.secrets["OPENROUTER_API_KEY"]
except (KeyError, FileNotFoundError):
    import os
    OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")

def chat_with_openrouter(messages, model="anthropic/claude-haiku-5.5"):
    """Send chat request to OpenRouter API"""
    
    if not OPENROUTER_API_KEY:
        return "⚠️ OpenRouter API key not configured. Please add it to Streamlit secrets."
    
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8501",
        "X-Title": "TripAdvisor Review Atlas"
    }
    
    payload = {
        "model": model,
        "messages": messages,
        "reasoning": {"effort": "none", "exclude": True}
    }
    
    try:
        response = requests.post(OPENROUTER_API_URL, headers=headers, json=payload)
        response.raise_for_status()
        return response.json()['choices'][0]['message']['content']
    except Exception as e:
        return f"Error: {str(e)}"

# Initialize session state
if 'df_viz' not in st.session_state:
    st.session_state['df_viz'] = None
if 'selected_data' not in st.session_state:
    st.session_state['selected_data'] = None
if 'chat_history' not in st.session_state:
    st.session_state['chat_history'] = []
if 'last_predicate' not in st.session_state:
    st.session_state['last_predicate'] = None

# Sidebar controls
with st.sidebar:
    st.title("🌍 Embedding Atlas")
    st.header("TripAdvisor Reviews")
    
    st.markdown("---")
    st.subheader("🤖 Chat Settings")
    chat_model = st.selectbox(
        "Model",
        [
            "anthropic/claude-haiku-5.5"
        ],
        help="Select AI model for chat"
    )

# Fragment for chat interface - only this reruns on chat interactions
@st.fragment
def chat_interface(selection, chat_model):
    """Chat interface as a fragment - reruns independently"""
    # Header and Clear button on the same row
    col_header, col_clear = st.columns([0.8, 0.2])
    with col_header:
        st.markdown("### 💬 Chat with Selected Reviews")
    with col_clear:
        if st.button("🗑️ Clear", help="Clear chat history"):
            st.session_state['chat_history'] = []
            st.rerun(scope="fragment")
    
    # Display chat history using chat_message
    chat_container = st.container(height=400)
    with chat_container:
        if not st.session_state['chat_history']:
            st.info("👋 Ask me anything about the selected reviews!")
            
        for msg in st.session_state['chat_history']:
            # Use different avatars/icons
            avatar = "👤" if msg['role'] == 'user' else "🤖"
            with st.chat_message(msg['role'], avatar=avatar):
                st.markdown(msg['content'])

    # Chat input
    # Using a form to ensure it works well within the fragment interaction model
    with st.form(key="chat_form", clear_on_submit=True):
        user_prompt = st.text_area(
            "Ask a question:",
            placeholder="E.g., What do people say about the breakfast?",
            height=100,
            key="chat_input_form"
        )
        
        # Right-aligned send button
        col_submit_spacer, col_submit_btn = st.columns([0.8, 0.2])
        with col_submit_btn:
            submit_button = st.form_submit_button("🚀 Send", type="primary", use_container_width=True)
        
        if submit_button and user_prompt:
            # Add user message immediately for responsiveness (optimistic update)
            # changes to session state will be reflected on rerun
            st.session_state['chat_history'].append({
                'role': 'user',
                'content': user_prompt
            })
            
            with st.spinner("Analyzing reviews..."):
                # Prepare context from selected reviews
                reviews_text = "\n\n".join([
                    f"Review {i+1} (Rating: {row['Rating']}): {row['description']}"
                    for i, row in selection.head(20).iterrows()
                ])
                
                # Create system message with context
                system_msg = f"""You are an AI assistant analyzing, enthusiastic TripAdvisor reviews. 

Here are the selected reviews to analyze:

{reviews_text}

Total reviews selected: {len(selection)}
Average rating: {selection['Rating'].mean():.2f}

Please answer the user's question based on these reviews. Be concise and helpful."""
                
                # Build messages for API
                messages = [
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": user_prompt}
                ]
                
                # Get response
                response = chat_with_openrouter(messages, model=chat_model)
                
                # Update chat history
                st.session_state['chat_history'].append({
                    'role': 'assistant',
                    'content': response
                })
                
                st.rerun(scope="fragment")

# Auto-load data on startup
if st.session_state['df_viz'] is None:
    try:
        import os
        current_dir = os.path.dirname(os.path.abspath(__file__))
        file_path = os.path.join(current_dir, 'reviews_projected.parquet')
        df = pd.read_parquet(file_path)
        st.session_state['df_viz'] = df
        st.toast("Data loaded successfully!", icon="✅")
    except FileNotFoundError:
        st.toast("❌ reviews_projected.parquet not found!", icon="❌")
        st.error("❌ reviews_projected.parquet not found!")
        st.info("Please run: python 2_reduce_dimensions.py")
        st.stop()
    except Exception as e:
        st.toast(f"❌ Error loading data", icon="❌")
        st.error(f"❌ Error loading data: {str(e)}")
        st.stop()

# Visualization
if st.session_state['df_viz'] is not None:
    df_viz = st.session_state['df_viz']
    
    st.header("🗺️ Interactive Review Atlas")
    
    # Custom CSS for improvements
    st.markdown("""
        <style>
        .stDataFrame { border: 1px solid #f0f2f6; border-radius: 0.5rem; }
        </style>
    """, unsafe_allow_html=True)
    
    try:
        value = embedding_atlas(
            df_viz,
            text="description",
            x="projection_x",
            y="projection_y",
            neighbors="neighbors",
            show_table=False,
            show_charts=False
        )
        
        # Handle selection
        if value and "predicate" in value:
            predicate = value.get("predicate")
            
            # Only process if predicate changed (new selection)
            if predicate is not None and predicate != st.session_state['last_predicate']:
                try:
                    selection = duckdb.query_df(
                        df_viz, "dataframe", 
                        "SELECT * FROM dataframe WHERE " + predicate
                    ).df()
                    
                    # Store selection and predicate
                    st.session_state['selected_data'] = selection
                    st.session_state['last_predicate'] = predicate
                    # Clear chat history on new selection
                    st.session_state['chat_history'] = []
                    
                except Exception as e:
                    st.error(f"Error querying selection: {str(e)}")
            
            # Display selected data and chat interface
            if st.session_state['selected_data'] is not None:
                selection = st.session_state['selected_data']
                
                st.markdown("---")
                
                # Create two columns for display and chat
                col1, col2 = st.columns([1.2, 1], gap="large")
                
                with col1:
                    st.markdown("### 📄 Selected Reviews Analysis")
                    
                    # Metrics Row
                    m1, m2, m3 = st.columns(3)
                    with m1:
                        st.metric("Total Reviews", len(selection))
                    with m2:
                        avg_rating = selection['Rating'].mean()
                        st.metric("Average Rating", f"{avg_rating:.1f} ⭐")
                    with m3:
                         # Placeholder for another metric if needed
                         pass

                    st.markdown("#### Review Details")
                    
                    # Enhanced DataFrame Display
                    st.dataframe(
                        selection[['Rating', 'description']],
                        column_config={
                            "Rating": st.column_config.NumberColumn(
                                "Rating",
                                help="User Rating (1-5)",
                                min_value=1,
                                max_value=5,
                                step=1,
                                format="%d ⭐"
                            ),
                            "description": st.column_config.TextColumn(
                                "Review Text",
                                help="Full text of the review",
                                width="large"
                            )
                        },
                        hide_index=True,
                        use_container_width=True,
                        height=400
                    )
                    
                    st.download_button(
                        label="📥 Download CSV",
                        data=selection.to_csv(index=False).encode('utf-8'),
                        file_name='selected_reviews.csv',
                        mime='text/csv',
                        type="secondary"
                    )
                
                with col2:
                    # Render chat interface as fragment
                    # Add a visual container/card effect
                    with st.container(border=True):
                        chat_interface(selection, chat_model)
        
    except Exception as e:
        st.error(f"❌ Error rendering Embedding Atlas: {str(e)}")
        st.exception(e)

else:
    st.info("⏳ Loading data...")

st.markdown("---")
st.markdown("Built with [Apple Embedding Atlas](https://apple.github.io/embedding-atlas/) | Powered by OpenRouter AI")
