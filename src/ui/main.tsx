import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// the preview answers only the app's own origin, http://127.0.0.1:<port>
if (location.hostname === 'localhost') location.replace(location.href.replace('//localhost', '//127.0.0.1'));
else createRoot(document.getElementById('root')!).render(<App />);
