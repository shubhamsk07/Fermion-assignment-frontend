import React from 'react'
import { BrowserRouter, Route, Router, Routes } from 'react-router-dom'
import P2P from './components/p2p'
import LiveHlsPlayer from './components/HlsPlayer'

const App = () => {
  return (

    <BrowserRouter>
    <Routes>
      <Route path='/main' element={<P2P />} />
      <Route path='/watch' element={<LiveHlsPlayer  src={'https://192.168.1.7:3001/public/stream.m3u8'}/>} />
    </Routes>
    </BrowserRouter>
  )
}

export default App